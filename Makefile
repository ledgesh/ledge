.PHONY: build run app test fmt clean probe web

CONFIG ?= debug
BIN    := .build/$(CONFIG)/LedgeApp
APP    := dist/Ledge.app

build:
	swift build -c $(CONFIG)

# The editor is CodeMirror in a WKWebView. Bun bundles it into Resources/editor,
# which `app` then copies into the .app bundle.
web:
	cd web && bun install && bun run build

# Both packages. The Bonsplit fork is ours now, so its tests are our tests.
test:
	swift test
	cd vendor/bonsplit && swift test

fmt:
	swiftformat Sources Tests Package.swift

# Assemble a real .app bundle. A bare SPM executable can show a window, but it
# gets no bundle identity, so menus, activation, and defaults all misbehave.
app: build web
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS $(APP)/Contents/Resources
	cp $(BIN) $(APP)/Contents/MacOS/Ledge
	cp Resources/Info.plist $(APP)/Contents/Info.plist
	cp -R Resources/editor $(APP)/Contents/Resources/editor
	codesign --force --sign - $(APP)

run: app
	open $(APP)

# Same bundle, but attached to the terminal so os_log/stderr is visible.
debug: app
	$(APP)/Contents/MacOS/Ledge

clean:
	rm -rf .build dist
probe:
	swift build && .build/debug/LedgeProbe
