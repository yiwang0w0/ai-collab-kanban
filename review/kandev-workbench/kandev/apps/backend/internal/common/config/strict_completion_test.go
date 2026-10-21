package config

import (
	"path/filepath"
	"testing"
)

func TestStrictCompletionConfiguration(t *testing.T) {
	cfg := &Config{}
	cfg.Database.Driver = "sqlite"
	if err := cfg.validateStrictCompletion(); err != nil {
		t.Fatal(err)
	}
	cfg.Tasks.CompletionVerifierID = "plugin:fixture"
	if cfg.validateStrictCompletion() == nil {
		t.Fatal("允许不完整严格配置")
	}
	root := t.TempDir()
	cfg.Tasks.CompletionNodePath = filepath.Join(root, "node.exe")
	cfg.Tasks.CompletionCheckerPath = filepath.Join(root, "check.mjs")
	cfg.Tasks.CompletionRepositoryRoot = root
	cfg.Tasks.CompletionRepositoryID = "repo-one"
	if cfg.validateStrictCompletion() == nil {
		t.Fatal("匿名模式可以开启人工验收")
	}
	cfg.Features.Auth = true
	if err := cfg.validateStrictCompletion(); err != nil {
		t.Fatal(err)
	}
	cfg.Database.Driver = "postgres"
	if cfg.validateStrictCompletion() == nil {
		t.Fatal("允许未验证的 PostgreSQL 严格验收")
	}
	cfg.Database.Driver = "sqlite"
	for key, target := range strictCompletionSettings(cfg) {
		if _, ok := CatalogEntryForKey(key); !ok {
			t.Fatalf("配置未登记: %s", key)
		}
		value := *target
		*target = ""
		if cfg.validateStrictCompletion() == nil {
			t.Fatalf("空值未拒绝: %s", key)
		}
		*target = value
	}
}
