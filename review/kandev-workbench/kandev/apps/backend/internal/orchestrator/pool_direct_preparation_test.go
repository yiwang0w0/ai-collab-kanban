package orchestrator

import (
	"context"
	"errors"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

type directPreparationAdmission interface {
	WithTaskPreparation(context.Context, string, func(context.Context) error) error
}

func directPreparation(t *testing.T, svc *Service) directPreparationAdmission {
	t.Helper()
	admission, ok := any(svc).(directPreparationAdmission)
	require.True(t, ok, "直接运行时准备必须复用原生任务准入")
	return admission
}

// @covers AC-TASKS-AGENT-POOL-001.4
func TestPoolDirectPreparationStopsBeforeRuntimeAndPreservesCallbackResult(t *testing.T) {
	svc := &Service{}
	admission := directPreparation(t, svc)
	denied := &runsmodels.PoolTaskBusyError{RunID: "current-native-run"}
	svc.SetPoolTaskStartGuard(poolStartGuardFunc(func(context.Context, string) error { return denied }))
	calls := 0
	want := errors.New("原生准备结果")
	prepare := func(ctx context.Context) error {
		require.False(t, ceilingEntryAdmissionLockHeld(ctx, "task"), "提供商 I/O 不能持任务写锁")
		calls++
		return want
	}
	require.ErrorIs(t, admission.WithTaskPreparation(t.Context(), "task", prepare), denied)
	require.Zero(t, calls)
	assertPoolAdmissionDrained(t, svc)
	svc.SetPoolTaskStartGuard(poolStartGuardFunc(func(context.Context, string) error { return nil }))
	require.ErrorIs(t, admission.WithTaskPreparation(t.Context(), "task", prepare), want)
	require.Equal(t, 1, calls)
	require.ErrorIs(t, admission.WithTaskPreparation(t.Context(), "task", nil), runsmodels.ErrPoolAdmissionUnavailable)
	require.ErrorIs(t, admission.WithTaskPreparation(t.Context(), "", prepare), runsmodels.ErrPoolAdmissionUnavailable)
	assertPoolAdmissionDrained(t, svc)
}

func TestPoolDirectPreparationOwnsAdmissionUntilCancelledCallbackSettles(t *testing.T) {
	svc := &Service{}
	svc.SetPoolTaskStartGuard(poolStartGuardFunc(func(context.Context, string) error { return nil }))
	admission := directPreparation(t, svc)
	ctx, cancel := context.WithCancel(t.Context())
	started, result := make(chan struct{}), make(chan error, 1)
	finished := make(chan struct{})
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("本测试启动的准备没有退出")
		}
	})
	go func() {
		defer close(finished)
		result <- admission.WithTaskPreparation(ctx, "task", func(ctx context.Context) error {
			close(started)
			<-ctx.Done()
			return ctx.Err()
		})
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("原生准备未进入")
	}
	require.ErrorIs(t, svc.WithPoolReleaseAdmission(t.Context(), "task", func(context.Context) error {
		t.Fatal("准备未退出前不能批准新派发")
		return nil
	}), runsmodels.ErrPoolTaskStartPreparing)
	cancel()
	select {
	case err := <-result:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(5 * time.Second):
		t.Fatal("取消后准备未退出")
	}
	require.NoError(t, svc.WithPoolReleaseAdmission(t.Context(), "task", func(context.Context) error { return nil }))
	assertPoolAdmissionDrained(t, svc)
}

func TestPoolDirectPreparationAuthorizesBeforeGuardAndKeepsUnconfiguredPath(t *testing.T) {
	denied := errors.New("不可见")
	svc := &Service{taskAccessCheck: func(context.Context, string) error { return denied }}
	admission := directPreparation(t, svc)
	svc.SetPoolTaskStartGuard(poolStartGuardFunc(func(context.Context, string) error {
		t.Fatal("未授权请求不能读取池占用")
		return nil
	}))
	require.ErrorIs(t, admission.WithTaskPreparation(t.Context(), "foreign", func(context.Context) error {
		t.Fatal("未授权请求不能准备资源")
		return nil
	}), denied)
	ordinary := &Service{}
	called := false
	require.NoError(t, directPreparation(t, ordinary).WithTaskPreparation(t.Context(), "task", func(context.Context) error {
		called = true
		return nil
	}))
	require.True(t, called, "未连接本池的普通原生准备保持可用")
	assertPoolAdmissionDrained(t, ordinary)
}
