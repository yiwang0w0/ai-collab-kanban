.PHONY: build test test-backend test-ui fmt check-format vet package package-host verify-package verify-package-host package-file
BIN := bin/kandev-plugin-fleet-acceptance
VERSION := 0.1.0

build:
	go build -trimpath -o $(BIN).exe ./server

test: test-backend test-ui
test-backend:
	go test -race ./server/...
test-ui:
	node --test tests/ui-panel.test.js
fmt:
	gofmt -w server
check-format:
	pwsh -NoProfile -Command '$$files = gofmt -l server; if ($$files) { Write-Output $$files; exit 1 }'
vet:
	go vet ./server/...
package package-host verify-package verify-package-host:
	pwsh -NoProfile -File scripts/package-windows.ps1
package-file:
	@echo kandev-plugin-fleet-acceptance-$(VERSION).tar.gz
