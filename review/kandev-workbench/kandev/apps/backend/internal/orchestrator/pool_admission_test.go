package orchestrator

import (
	"context"
	"testing"
)

type poolAdmissionCoordinator interface {
	WithPoolReleaseAdmission(context.Context, string, func(context.Context) error) error
	WithPoolEnqueueAdmission(context.Context, string, func(context.Context, bool) error) error
	SetPoolTaskStartGuard(PoolTaskStartGuard)
}

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolAdmissionUsesNativeTaskLockAndPreservesNestedOwnership(t *testing.T) {
	svc := &Service{}
	coordinator, ok := any(svc).(poolAdmissionCoordinator)
	if !ok {
		t.Fatal("缺少与原生任务锁共享的池准入接缝")
	}
	called := false
	err := coordinator.WithPoolReleaseAdmission(context.Background(), "task", func(ctx context.Context) error {
		if !ceilingEntryAdmissionLockHeld(ctx, "task") {
			t.Fatal("批准与发布必须借用真实原生锁")
		}
		return coordinator.WithPoolEnqueueAdmission(ctx, "task", func(nested context.Context, preparing bool) error {
			called = true
			if !ceilingEntryAdmissionLockHeld(nested, "task") || preparing {
				t.Fatal("同任务嵌套发布应保持原生锁身份，不能虚报启动占用")
			}
			return nil
		})
	})
	if err != nil || !called {
		t.Fatalf("原生确认／发布应能安全嵌套: called=%t err=%v", called, err)
	}
	svc.ceilingEntryAdmissionLocksMu.Lock()
	remaining := len(svc.ceilingEntryAdmissionLocks)
	svc.ceilingEntryAdmissionLocksMu.Unlock()
	if remaining != 0 {
		t.Fatalf("退出后必须释放原生锁引用: %d", remaining)
	}
}

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolAdmissionReleasedContextCannotClaimCurrentLockOwnership(t *testing.T) {
	svc := &Service{}
	var captured context.Context
	err := svc.WithPoolReleaseAdmission(context.Background(), "task", func(ctx context.Context) error {
		captured = context.WithoutCancel(ctx)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if ceilingEntryAdmissionLockHeld(captured, "task") {
		t.Fatal("提交后保留的上下文不能继续冒充持锁者")
	}
	err = svc.WithPoolReleaseAdmission(captured, "task", func(ctx context.Context) error {
		if ctx == captured || !ceilingEntryAdmissionLockHeld(ctx, "task") {
			t.Fatal("晚到的回调必须重新取得本次锁所有权")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
