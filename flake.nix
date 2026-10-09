{
  description = "Schema-agnostic personal data store: local-first SQLite with an agent-friendly CLI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          pythonPkgs = pkgs.python313Packages;
        in
        rec {
          soma = pythonPkgs.buildPythonApplication {
            pname = "soma";
            version = "0.1.0";
            src = ./.;
            pyproject = true;
            build-system = [ pythonPkgs.uv-build ];
            pythonImportsCheck = [ "soma" ];
            meta.mainProgram = "soma";
          };
          default = soma;
        });

      # Installs the CLI, optional defaults and supervised background runner.
      # Users opt in with `soma background enable`.
      homeModules = rec {
        soma = import ./nix/hm-module.nix self;
        default = soma;
      };
    };
}
