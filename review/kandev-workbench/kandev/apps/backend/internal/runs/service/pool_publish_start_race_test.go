package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
)

var errPoolStartPreflight = errors.New("仅暂停原生启动预检，不调用执行器")

type poolStartPreflightBarrier struct {
	entered chan struct{}
	settled chan struct{}
}

func (g poolStartPreflightBarrier) GetStep(ctx context.Context, _ string) (*wfmodels.WorkflowStep, error) {
	select {
	case g.entered <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case <-g.settled:
		return nil, errPoolStartPreflight
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (poolStartPreflightBarrier) GetNextStepByPosition(context.Context, string, int) (*wfmodels.WorkflowStep, error) {
	return nil, errPoolStartPreflight
}

func (poolStartPreflightBarrier) GetPreviousStepByPosition(context.Context, string, int) (*wfmodels.WorkflowStep, error) {
	return nil, errPoolStartPreflight
}

func (poolStartPreflightBarrier) GetWorkflowMeta(context.Context, string) (orchestrator.WorkflowMeta, error) {
	return orchestrator.WorkflowMeta{}, errPoolStartPreflight
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-002.1
func TestPoolDispatchPublicationAndNativeStartShareActualAdmission(t *testing.T) {
	f := newPoolPublishFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	barrier := poolStartPreflightBarrier{entered: make(chan struct{}, 2), settled: make(chan struct{})}
	coordinator := &orchestrator.Service{}
	coordinator.SetWorkflowStepGetter(barrier)
	coordinator.SetPoolTaskStartGuard(nativePoolStartGuard(t, f.svc))
	f.svc.SetPoolEnqueueAdmission(coordinator)
	finished := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := coordinator.StartTask(ctx, f.task.ID, f.step.AgentProfileID, "", "", "", "", f.step.ID, false, false, nil)
			finished <- err
		}()
	}
	for range 2 {
		select {
		case <-barrier.entered:
		case <-time.After(3 * time.Second):
			t.Fatal("普通并行启动必须都能进入会话产生前的读取")
		}
	}
	outcome, row, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if !errors.Is(err, runsmodels.ErrPoolTaskStartPreparing) || outcome != runsservice.QueueOutcomeNone || row != nil {
		t.Fatalf("真实启动准备窗口内不能插入运行: %s %+v %v", outcome, row, err)
	}
	var runs, sessions int
	if err := f.runs.Reader().Get(&runs, `SELECT COUNT(*) FROM runs`); err != nil {
		t.Fatal(err)
	}
	if err := f.runs.Reader().Get(&sessions, `SELECT COUNT(*) FROM task_sessions WHERE task_id = ?`, f.task.ID); err != nil || runs != 0 || sessions != 0 {
		t.Fatalf("必须覆盖尚无原生会话的窗口: runs=%d sessions=%d err=%v", runs, sessions, err)
	}
	close(barrier.settled)
	for range 2 {
		select {
		case err := <-finished:
			if !errors.Is(err, errPoolStartPreflight) {
				t.Fatalf("启动必须退出于受控读取，不调用执行器: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("原生启动没有退出准备阶段")
		}
	}
	outcome, row, err = f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err != nil || row == nil || outcome != runsservice.QueueOutcomeQueued {
		t.Fatalf("同一真实队列在启动退出后应可发布: %s %+v %v", outcome, row, err)
	}
	_, err = coordinator.StartTask(ctx, f.task.ID, f.step.AgentProfileID, "", "", "", "", f.step.ID, false, false, nil)
	var busy *runsmodels.PoolTaskBusyError
	if !errors.As(err, &busy) || busy.RunID != row.ID {
		t.Fatalf("已发布后反向拒绝普通启动，不能再进入预检: %v", err)
	}
}
