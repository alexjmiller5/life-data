# home-manager module for life-data — exported as `homeModules.default`.
# Consumers toggle `lifeData.enable` and supply only what the product cannot
# know: how each context on this machine obtains the hub credential.
#
# The two contexts are deliberately independent:
#   cli.tokenCommand   → written to config.json as token_cmd; interactive
#                        `life` invocations run it in the caller's own env.
#   watch.tokenCommand → evaluated ONCE by the daemon wrapper at startup and
#                        exported as LIFE_HUB_TOKEN, which the product
#                        prefers over token_cmd — so the daemon never touches
#                        config.json's credential path at all.
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
    runtimeInputs = [ cfg.package ] ++ cfg.watch.packages;
    text = ''
      LIFE_HUB_TOKEN="$(${cfg.watch.tokenCommand})"
      export LIFE_HUB_TOKEN
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

    hubUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Hub to sync with. Null uses the CLI's built-in default (the hosted service); set to self-host.";
    };

    cli.tokenCommand = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "op read 'op://vault/item/credential'";
      description = ''
        Credential command for INTERACTIVE `life` use, written to config.json
        as token_cmd and run in the calling shell's environment. Null
        configures none; hub commands then need LIFE_HUB_TOKEN set.
      '';
    };

    watch = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Run `life watch` as a background agent: pushes local writes within ~1s, polls for remote changes. (launchd; macOS only.)";
      };
      tokenCommand = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = ''TOKEN_ENV="$(cat /path/to/session)" fetch-secret hub-token'';
        description = ''
          Credential command for the DAEMON, evaluated once at startup and
          exported as LIFE_HUB_TOKEN. Must be self-sufficient: background
          agents start with no login-shell environment, so include any
          environment its own tooling needs inline.
        '';
      };
      packages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        description = "Extra packages watch.tokenCommand needs on PATH (the daemon's PATH is minimal).";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.watch.enable || cfg.watch.tokenCommand != null;
        message = "lifeData.watch.enable requires lifeData.watch.tokenCommand (the daemon has no other way to authenticate).";
      }
    ];

    # duckdb powers `life archive query --raw` (analytical fallback over raw
    # stream objects)
    home.packages = [
      cfg.package
      pkgs.duckdb
    ];

    # Read-only by design: this is machine config; all of the app's mutable
    # state lives in the database, never here.
    xdg.dataFile."life-data/config.json".text = builtins.toJSON (
      lib.optionalAttrs (cfg.cli.tokenCommand != null) { token_cmd = cfg.cli.tokenCommand; }
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
