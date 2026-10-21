package config

import (
	"errors"
	"path/filepath"
	"strings"
)

func strictCompletionSettings(cfg *Config) map[string]*string {
	return map[string]*string{
		"tasks.completionVerifierId":     &cfg.Tasks.CompletionVerifierID,
		"tasks.completionNodePath":       &cfg.Tasks.CompletionNodePath,
		"tasks.completionCheckerPath":    &cfg.Tasks.CompletionCheckerPath,
		"tasks.completionRepositoryId":   &cfg.Tasks.CompletionRepositoryID,
		"tasks.completionRepositoryRoot": &cfg.Tasks.CompletionRepositoryRoot,
	}
}

func (cfg *Config) validateStrictCompletion() error {
	t := cfg.Tasks
	values := []string{t.CompletionVerifierID, t.CompletionNodePath, t.CompletionCheckerPath, t.CompletionRepositoryID, t.CompletionRepositoryRoot}
	set := 0
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			set++
		}
	}
	if set == 0 {
		return nil
	}
	if set != len(values) || !strings.HasPrefix(t.CompletionVerifierID, "plugin:") || len(strings.TrimPrefix(t.CompletionVerifierID, "plugin:")) == 0 {
		return errors.New("严格验收配置必须同时指定插件安装身份、Node、校验脚本、仓库 ID 与根目录")
	}
	if !cfg.Features.Auth {
		return errors.New("严格验收要求启用 features.auth，匿名本地调用不能作为人工验收")
	}
	if strings.ToLower(cfg.Database.Driver) != "sqlite" {
		return errors.New("本批严格验收只支持单机 SQLite；PostgreSQL 尚未验证")
	}
	if !filepath.IsAbs(t.CompletionNodePath) || !filepath.IsAbs(t.CompletionCheckerPath) || !filepath.IsAbs(t.CompletionRepositoryRoot) {
		return errors.New("严格验收程序与仓库必须使用绝对路径")
	}
	return nil
}
