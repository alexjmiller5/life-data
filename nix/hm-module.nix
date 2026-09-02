# home-manager module for life-data — exported as `homeModules.default`.
# Consumers toggle `lifeData.enable` and supply only what the product cannot
# know: how to obtain the hub credential on this machine.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.lifeData;
  watchBin = pkgs.writeShellApplication {
    name = "life-data-watch";
    runtimeInputs = [ cfg.package ];
    text = ''
      ${cfg.watch.setup}
      life init >/dev/null
      exec life watch
    '';
  };
in
{
  options.lifeData = {
    enable = lib.mkEnableOption "life-data (local-first personal data store: `life` CLI + continuous sync)";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "life-data.packages.<system>.default";
      description = "The life-data package providing the `life` CLI.";
    };

    tokenCommand = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "op read 'op://vault/item/credential'";
      description = ''
        Command whose stdout is the hub bearer token (written to config.json
        as token_cmd). Null configures no credential; hub commands then rely
        on the LIFE_HUB_TOKEN environment variable.
      '';
    };

    hubUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Hub to sync with. Null uses the CLI's built-in default (the hosted service); set to self-host.";
    };

    watch = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Run `life watch` as a background agent: pushes local writes within ~1s, polls for remote changes. (launchd; macOS only.)";
      };
      setup = lib.mkOption {
        type = lib.types.lines;
        default = "";
        description = ''
          Shell prelude for the watch daemon. Background agents start without
          a login shell environment, so export here whatever tokenCommand
          needs to succeed (e.g. a secret-manager session variable).
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    # duckdb powers `life archive query --raw` (analytical fallback over raw
    # stream objects)
    home.packages = [
      cfg.package
      pkgs.duckdb
    ];

    # Read-only by design: this is machine config; all of the app's mutable
    # state lives in the database, never here.
    xdg.dataFile."life-data/config.json".text = builtins.toJSON (
      lib.optionalAttrs (cfg.tokenCommand != null) { token_cmd = cfg.tokenCommand; }
      // lib.optionalAttrs (cfg.hubUrl != null) { hub_url = cfg.hubUrl; }
    );

    launchd.agents.life-data-watch = lib.mkIf (cfg.watch.enable && pkgs.stdenv.isDarwin) {
      enable = true;
      config = {
        Label = "sh.life-data.watch";
        ProgramArguments = [ "${watchBin}/bin/life-data-watch" ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 30;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/life-data-watch.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/life-data-watch.log";
      };
    };
  };
}
