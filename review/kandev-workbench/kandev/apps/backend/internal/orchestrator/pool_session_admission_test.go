package orchestrator

import (
	"context"
	"errors"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
)

type poolSessionReadRepo struct {
	sessionExecutorStore
	onRead func(context.Context) error
}

func (r *poolSessionReadRepo) GetTaskSession(ctx context.Context, _ string) (*models.TaskSession, error) {
	return nil, r.onRead(ctx)
}

func invokePoolSessionEntry(ctx context.Context, svc *Service, action, sessionID string) error {
	switch action {
	case "created":
		_, err := svc.StartCreatedSession(ctx, "pool-preparing", sessionID, "profile", "提示", false, false, false, nil, nil)
		return err
	case "resume":
		_, err := svc.ResumeTaskSession(ctx, "pool-preparing", sessionID)
		return err
	case "resume-prompt":
		_, err := svc.ResumeTaskSessionAndPrompt(ctx, "pool-preparing", sessionID, "提示", "", false, nil)
		return err
	case "prompt":
		_, err := svc.PromptTask(ctx, "pool-preparing", sessionID, "提示", "", false, nil, false)
		return err
	default:
		return errors.New("未知测试入口")
	}
}

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolSessionEntryAdmissionPrecedesSessionRead(t *testing.T) {
	for _, action := range []string{"created", "resume", "resume-prompt", "prompt"} {
		t.Run(action, func(t *testing.T) {
			svc, _ := newServiceWithRealRepo(t)
			reads := 0
			svc.repo = &poolSessionReadRepo{sessionExecutorStore: svc.repo, onRead: func(context.Context) error {
				reads++
				return errPoolStartReadPaused
			}}
			denied := &runsmodels.PoolTaskBusyError{RunID: "actual-pool-run"}
			svc.SetPoolTaskStartGuard(poolStartGuardFunc(func(ctx context.Context, taskID string) error {
				if taskID != "pool-preparing" || !ceilingEntryAdmissionLockHeld(ctx, taskID) {
					t.Fatal("会话入口必须借用同一任务准入")
				}
				return denied
			}))
			if err := invokePoolSessionEntry(context.Background(), svc, action, "session"); !errors.Is(err, denied) || reads != 0 {
				t.Fatalf("池占用应在首次会话读取前拒绝: reads=%d err=%v", reads, err)
			}
			assertPoolAdmissionDrained(t, svc)
			svc.SetPoolTaskStartGuard(poolStartGuardFunc(func(context.Context, string) error { return nil }))
			if err := invokePoolSessionEntry(context.Background(), svc, action, "session"); !errors.Is(err, errPoolStartReadPaused) || reads != 1 {
				t.Fatalf("相同夹具放行后必须确实抵达读取正对照: reads=%d err=%v", reads, err)
			}
			assertPoolAdmissionDrained(t, svc)
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolSessionEntryPreparationBlocksNewReleaseUntilAllSettle(t *testing.T) {
	svc, _ := newServiceWithRealRepo(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	reads := make(chan poolStartRead, 4)
	svc.repo = &poolSessionReadRepo{sessionExecutorStore: svc.repo, onRead: func(ctx context.Context) error {
		read := poolStartRead{ctx: ctx, finish: make(chan struct{})}
		select {
		case reads <- read:
		case <-ctx.Done():
			return ctx.Err()
		}
		select {
		case <-read.finish:
			return errPoolStartReadPaused
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	svc.SetPoolTaskStartGuard(poolStartGuardFunc(func(context.Context, string) error { return nil }))
	results := make(chan error, 4)
	for _, action := range []string{"created", "resume", "resume-prompt", "prompt"} {
		go func() { results <- invokePoolSessionEntry(ctx, svc, action, action+"-session") }()
	}
	var pending []poolStartRead
	for range 4 {
		pending = append(pending, awaitPoolStartRead(t, reads))
	}
	assertPoolPreparing(t, svc, ctx, true)
	for index, read := range pending {
		if ceilingEntryAdmissionLockHeld(read.ctx, "pool-preparing") {
			t.Fatal("不能持任务锁等待会话或提供商 I/O")
		}
		close(read.finish)
		awaitPoolStartResult(t, results)
		assertPoolPreparing(t, svc, ctx, index < len(pending)-1)
	}
	assertPoolAdmissionDrained(t, svc)
}
