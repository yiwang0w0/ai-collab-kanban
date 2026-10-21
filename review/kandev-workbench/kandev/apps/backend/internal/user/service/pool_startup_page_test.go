package service

import (
	"context"
	"testing"

	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/user/models"
	"go.uber.org/zap"
)

// @covers AC-TASKS-AGENT-POOL-003.1
func TestPoolStartupPageUsesNativePreference(t *testing.T) {
	settings := &models.UserSettings{StartupPage: "threads", KanbanViewMode: "kanban"}
	if err := applyStartupPage(settings, ptr(" task_pool ")); err != nil {
		t.Fatal(err)
	}
	if settings.StartupPage != "task_pool" || settings.KanbanViewMode != "kanban" {
		t.Fatalf("入口偏好不得覆盖看板偏好: %#v", settings)
	}
	if got := models.NormalizeStartupPage(settings.StartupPage); got != "task_pool" {
		t.Fatalf("原生读取丢失入口偏好: %q", got)
	}
	if err := applyStartupPage(settings, nil); err != nil || settings.StartupPage != "task_pool" {
		t.Fatalf("省略字段改变了偏好: %q / %v", settings.StartupPage, err)
	}
	if err := applyStartupPage(settings, ptr("invalid")); err == nil || settings.StartupPage != "task_pool" {
		t.Fatalf("无效入口未失败关闭: %q / %v", settings.StartupPage, err)
	}
}

func TestPoolStartupPageNativeEvent(t *testing.T) {
	log, err := logger.NewFromZap(zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	events := &recordingEventBus{}
	svc := NewService(&recordingUserRepository{}, events, log)
	svc.publishUserSettingsEvent(context.Background(), &models.UserSettings{StartupPage: "task_pool"})
	if len(events.publishedEvents) != 1 {
		t.Fatal("缺少原生设置事件")
	}
	data, ok := events.publishedEvents[0].Data.(map[string]interface{})
	if !ok || data["startup_page"] != "task_pool" {
		t.Fatalf("设置事件丢失偏好: %#v", data)
	}
}
