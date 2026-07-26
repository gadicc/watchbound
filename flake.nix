{
  description = "Watchbound source-built Node-API package and Codex Electron qualification";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        matrix = builtins.fromJSON (builtins.readFile ./config/native-matrix.json);
        rootPackage = builtins.fromJSON (builtins.readFile ./package.json);
        target =
          if system == "x86_64-linux" then builtins.elemAt matrix.targets 0
          else if system == "aarch64-linux" then builtins.elemAt matrix.targets 1
          else throw "Watchbound is not configured for ${system}";
        sourceRoot = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            pkgs.lib.cleanSourceFilter path type
            && !(pkgs.lib.hasInfix "/target/" (toString path))
            && !(pkgs.lib.hasInfix "/dist/" (toString path))
            && !(pkgs.lib.hasInfix "/node_modules/" (toString path))
            && !(pkgs.lib.hasSuffix "/target" (toString path))
            && !(pkgs.lib.hasSuffix "/dist" (toString path))
            && !(pkgs.lib.hasSuffix "/node_modules" (toString path))
            && !(pkgs.lib.hasSuffix ".node" (toString path));
        };
        node = pkgs.nodejs_24;
        electronLibs = with pkgs; [
          glib gtk3 pango cairo gdk-pixbuf atk at-spi2-atk at-spi2-core
          nss nspr dbus cups expat libdrm mesa libgbm alsa-lib libX11
          libXcomposite libXdamage libXext libXfixes libXrandr libxcb
          libxkbcommon libxcursor libxi libxtst libxscrnsaver libnotify
          libglvnd systemd wayland
        ];
        electronLibPath = pkgs.lib.makeLibraryPath electronLibs;
        electronRuntimeLibPath = pkgs.lib.makeLibraryPath (with pkgs; [
          libxcrypt-legacy stdenv.cc.cc.lib zlib
        ]);
        electronZip = pkgs.fetchurl {
          url = "https://github.com/electron/electron/releases/download/v${matrix.codexRuntime.electron}/electron-v${matrix.codexRuntime.electron}-linux-${target.codexElectron.archiveArchitecture}.zip";
          hash = target.codexElectron.sha256SRI;
        };
        electronRuntime = pkgs.stdenv.mkDerivation {
          pname = "watchbound-codex-electron";
          version = matrix.codexRuntime.electron;
          src = electronZip;
          nativeBuildInputs = [ pkgs.makeWrapper pkgs.patchelf pkgs.unzip ];
          dontUnpack = true;
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p "$out/lib/electron" "$out/bin"
            unzip -q "$src" -d "$out/lib/electron"
            patchelf \
              --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
              --set-rpath "$out/lib/electron:${electronLibPath}" \
              "$out/lib/electron/electron"
            if [ -f "$out/lib/electron/chrome_crashpad_handler" ]; then
              patchelf \
                --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
                "$out/lib/electron/chrome_crashpad_handler"
            fi
            find "$out/lib/electron" -maxdepth 1 -name '*.so*' -type f -print0 \
              | xargs -0 -r -n1 patchelf --set-rpath "${electronLibPath}"
            makeWrapper "$out/lib/electron/electron" "$out/bin/electron" \
              --prefix LD_LIBRARY_PATH : "${electronLibPath}:${electronRuntimeLibPath}"
            runHook postInstall
          '';
        };
        watchboundNative = pkgs.rustPlatform.buildRustPackage {
          pname = "watchbound-native-${target.id}";
          version = rootPackage.version;
          src = sourceRoot;
          cargoLock.lockFile = ./Cargo.lock;
          cargoBuildFlags = [ "-p" "watchbound-node" ];
          doCheck = false;
          installPhase = ''
            runHook preInstall
            release_dir="target/''${CARGO_BUILD_TARGET:-${target.rustTarget}}/release"
            if [ ! -f "$release_dir/libwatchbound_node.so" ]; then
              release_dir="target/release"
            fi
            install -Dm0555 "$release_dir/libwatchbound_node.so" "$out/lib/${target.binary}"
            runHook postInstall
          '';
        };
        watchboundPackage = pkgs.stdenv.mkDerivation {
          pname = "watchbound-node-package-${target.id}";
          version = rootPackage.version;
          src = sourceRoot;
          nativeBuildInputs = [ node ];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            node scripts/generate-nix-package.mjs \
              --target ${target.id} \
              --artifact ${watchboundNative}/lib/${target.binary} \
              --output "$out"
            runHook postInstall
          '';
        };
        packageSmoke = pkgs.runCommand "watchbound-nix-package-smoke-${target.id}" {
          nativeBuildInputs = [ node ];
        } ''
          mkdir -p "$TMPDIR/project"
          ln -s ${watchboundPackage}/lib/node_modules "$TMPDIR/project/node_modules"
          native="${watchboundPackage}/lib/node_modules/${target.package}/${target.binary}"
          digest="$(sha256sum "$native" | cut -d ' ' -f 1)"
          node ${sourceRoot}/scripts/check-installed-package.mjs \
            --project "$TMPDIR/project" \
            --wrapper watchbound \
            --version ${rootPackage.version} \
            --native-target ${target.id} \
            --native-sha256 "$digest" \
            --route nix-${system} \
            --evidence "$TMPDIR/nix-package-smoke.json"
          cp "$TMPDIR/nix-package-smoke.json" "$out"
        '';
        electronSmoke = pkgs.runCommand "watchbound-codex-electron-asar-${target.id}" {
            nativeBuildInputs = [ pkgs.asar electronRuntime ];
          } ''
            mkdir -p "$TMPDIR/app"
            cp -R ${watchboundPackage}/lib/node_modules "$TMPDIR/app/node_modules"
            cp ${sourceRoot}/scripts/fixtures/electron-asar-smoke.cjs "$TMPDIR/app/index.cjs"
            echo '{"private":true,"main":"index.cjs"}' > "$TMPDIR/app/package.json"
            asar pack "$TMPDIR/app" "$TMPDIR/app.asar" --unpack "*.node"
            native="${watchboundPackage}/lib/node_modules/${target.package}/${target.binary}"
            digest="$(sha256sum "$native" | cut -d ' ' -f 1)"
            ELECTRON_RUN_AS_NODE=1 \
              WATCHBOUND_EXPECTED_TARGET=${target.id} \
              WATCHBOUND_EXPECTED_NATIVE_SHA256="$digest" \
              electron "$TMPDIR/app.asar" > "$out"
            grep -q '"status":"passed"' "$out"
          '';
      in {
        packages = {
          default = watchboundPackage;
          native = watchboundNative;
        };
        checks = {
          default = packageSmoke;
          package = packageSmoke;
          codex-electron-asar = electronSmoke;
        };
      });
}
