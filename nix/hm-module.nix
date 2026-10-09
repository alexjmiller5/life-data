# Installs Soma and a supervised runner. Sync stays off until the user runs
# `soma background enable`; preferences and credentials are app state.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.soma;
  watchBin = pkgs.writeShellApplication {
    name = "soma-watch";
    runtimeInputs = [ cfg.package ] ++ cfg.watch.packages;
    text = ''
      exec soma background run
    '';
  };
in
{
  options.services.soma = {
    enable = lib.mkEnableOption "soma (local-first personal data store: `soma` CLI + continuous sync)";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "soma.packages.<system>.default";
      description = "The soma package providing the `soma` CLI.";
    };

    hubUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Hub to sync with. Null uses the CLI's built-in default (the hosted service); set to self-host.";
    };

    cli.tokenCommand = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "credential-tool read hub-token";
      description = ''
        Credential command for INTERACTIVE `soma` use, written to config.json
        as token_cmd and run in the calling shell's environment. Null
        configures none; hub commands then need SOMA_HUB_TOKEN set.
      '';
    };

    watch = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Install the supervised background runner. Sync stays disabled until `soma background enable`. (launchd; macOS only.)";
      };
      tokenCommand = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = ''TOKEN_ENV="$(cat /path/to/session)" fetch-secret hub-token'';
        description = ''
          Optional default credential command for background sync. Users may
          instead supply a token through the CLI and macOS Keychain, or provide
          SOMA_HUB_TOKEN in the runner environment. Independent of cli.tokenCommand.
          Commands run only while sync is enabled, with bounded retries on failure.
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
    # duckdb powers `soma archive query --raw` (analytical fallback over raw
    # stream objects)
    home.packages = [
      cfg.package
      pkgs.duckdb
    ];

    # Read-only by design: this is machine config; all of the app's mutable
    # state lives in the database, never here.
    xdg.dataFile."soma/config.json".text = builtins.toJSON (
      lib.optionalAttrs (cfg.cli.tokenCommand != null) { token_cmd = cfg.cli.tokenCommand; }
      // lib.optionalAttrs (cfg.hubUrl != null) { hub_url = cfg.hubUrl; }
      // lib.optionalAttrs (cfg.watch.tokenCommand != null) { background_token_cmd = cfg.watch.tokenCommand; }
    );

    launchd.agents.soma-watch = lib.mkIf (cfg.watch.enable && pkgs.stdenv.hostPlatform.isDarwin) {
      enable = true;
      config = {
        Label = "com.alexmiller.soma.watch";
        ProgramArguments = [ "${watchBin}/bin/soma-watch" ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 30;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/soma-watch.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/soma-watch.log";
      };
    };
  };
}
