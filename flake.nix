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
          life-data = pythonPkgs.buildPythonApplication {
            pname = "life-data";
            version = "0.1.0";
            src = ./.;
            pyproject = true;
            build-system = [ pythonPkgs.uv-build ];
            pythonImportsCheck = [ "life_data" ];
            meta.mainProgram = "life";
          };
          default = life-data;
        });
    };
}
