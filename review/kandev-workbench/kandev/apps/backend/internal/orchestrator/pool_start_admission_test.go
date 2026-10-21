package orchestrator

import (
	"context"
	"errors"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
)

var errPoolStartReadPaused = errors.New("启动读取测试边界")

type poolStartRead struct {
	ctx    context.Context
	finish chan struct{}
}

type poolStartBarrierRepo struct {
	sessionExecutorStore
	reads chan poolStartRead
}

func (r *poolStartBarrierRepo) GetTask(ctx context.Context, _ string) (*models.Task, error) {
	read := poolStartRead{ctx: ctx, finish: make(chan struct{})}
	select {
	case r.reads <- read:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case <-read.finish:
		return nil, errPoolStartReadPaused
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type poolStartGuardFunc func(context.Context, string) error

func (f poolStartGuardFunc) CheckPoolTaskStart(ctx context.Context, taskID string) error {
	return f(ctx, taskID)
}

func awaitPoolStartRead(t *testing.T, reads <-chan poolStartRead) poolStartRead {
	t.Helper()
	select {
	case read := <-reads:
		return read
	case <-time.After(3 * time.Second):
		t.Fatal("普通并行启动未到达首次读取边界")
		return poolStartRead{}
	}
}

func awaitPoolStartResult(t *testing.T, results <-chan error) {
	t.Helper()
	select {
	case err := <-results:
		if !errors.Is(err, errPoolStartReadPaused) {
			t.Fatalf("应在首次读取边界退出，不能进入执行器: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("启动没有释放测试边界")
	}
}

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolAdmissionBlocksReleaseUntilAllNativeStartsSettle(t *testing.T) {
	svc, repo := newServiceWithRealRepo(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := repo.CreateTask(ctx, &models.Task{ID: "pool-preparing", Title: "启动窗口"}); err != nil {
		t.Fatal(err)
	}
	reads := make(chan poolStartRead, 2)
	svc.repo = &poolStartBarrierRepo{sessionExecutorStore: svc.repo, reads: reads}
	svc.workflowStepGetter = newMockStepGetter()
	svc.SetPoolTaskStartGuard(poolStartGuardFunc(func(context.Context, string) error { return nil }))
	results := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := svc.StartTask(ctx, "pool-preparing", "profile", "", "", "", "", "", false, false, nil)
			results <- err
		}()
	}
	first, second := awaitPoolStartRead(t, reads), awaitPoolStartRead(t, reads)
	for _, read := range []poolStartRead{first, second} {
		if ceilingEntryAdmissionLockHeld(read.ctx, "pool-preparing") {
			t.Fatal("启动准备的 I/O 上下文不能携带已释放的锁身份")
		}
	}
	assertPoolPreparing(t, svc, ctx, true)
	sessions, err := repo.ListTaskSessions(ctx, "pool-preparing")
	if err != nil || len(sessions) != 0 {
		t.Fatalf("测试必须停在会话行产生之前: sessions=%d err=%v", len(sessions), err)
	}
	close(first.finish)
	awaitPoolStartResult(t, results)
	assertPoolPreparing(t, svc, ctx, true)
	close(second.finish)
	awaitPoolStartResult(t, results)
	assertPoolPreparing(t, svc, ctx, false)
	assertPoolAdmissionDrained(t, svc)
}

func assertPoolAdmissionDrained(t *testing.T, svc *Service) {
	t.Helper()
	svc.ceilingEntryAdmissionLocksMu.Lock()
	remaining := len(svc.ceilingEntryAdmissionLocks)
	svc.ceilingEntryAdmissionLocksMu.Unlock()
	if remaining != 0 {
		t.Fatalf("启动退出后不得保留任务锁或准备引用: %d", remaining)
	}
}

func assertPoolPreparing(t *testing.T, svc *Service, ctx context.Context, want bool) {
	t.Helper()
	called := false
	err := svc.WithPoolReleaseAdmission(ctx, "pool-preparing", func(context.Context) error { called = true; return nil })
	if want {
		if !errors.Is(err, runsmodels.ErrPoolTaskStartPreparing) || called {
			t.Fatalf("准备中不能提交新批准: called=%t err=%v", called, err)
		}
	} else if err != nil || !called {
		t.Fatalf("所有启动退出后应允许批准: called=%t err=%v", called, err)
	}
	err = svc.WithPoolEnqueueAdmission(ctx, "pool-preparing", func(admitted context.Context, preparing bool) error {
		if !ceilingEntryAdmissionLockHeld(admitted, "pool-preparing") || preparing != want {
			t.Fatalf("队列事务需要真实锁与当前占用: preparing=%t want=%t", preparing, want)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolAdmissionRejectsNativeStartBeforeTaskReads(t *testing.T) {
	svc, _ := newServiceWithRealRepo(t)
	svc.workflowStepGetter = newMockStepGetter()
	denied := errors.New("队列仍拥有本任务")
	svc.SetPoolTaskStartGuard(poolStartGuardFunc(func(ctx context.Context, taskID string) error {
		if taskID != "pool-denied" || !ceilingEntryAdmissionLockHeld(ctx, taskID) {
			t.Fatal("队列核验必须位于共享任务锁内")
		}
		return denied
	}))
	_, err := svc.StartTask(context.Background(), "pool-denied", "profile", "", "", "", "", "", false, false, nil)
	if !errors.Is(err, denied) {
		t.Fatalf("准入拒绝必须早于任务读取或执行器调用: %v", err)
	}
	assertPoolAdmissionDrained(t, svc)
}
