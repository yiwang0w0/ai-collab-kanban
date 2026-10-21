package service_test

import (
	"context"
	"errors"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
)

type poolEnqueueCoordinatorSetter interface {
	SetPoolEnqueueAdmission(runsservice.PoolEnqueueAdmission)
}

type poolEnqueueAdmissionFunc func(context.Context, string, func(context.Context, bool) error) error

func (f poolEnqueueAdmissionFunc) WithPoolEnqueueAdmission(ctx context.Context, taskID string, fn func(context.Context, bool) error) error {
	return f(ctx, taskID, fn)
}

func setPoolEnqueueCoordinator(t *testing.T, svc *runsservice.Service, gate runsservice.PoolEnqueueAdmission) {
	t.Helper()
	setter, ok := any(svc).(poolEnqueueCoordinatorSetter)
	if !ok {
		t.Fatal("池发布器缺少与原生启动共享的准入")
	}
	setter.SetPoolEnqueueAdmission(gate)
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-002.1
func TestPoolDispatchPublicationPreparingBlocksNewButPreservesDurableReplay(t *testing.T) {
	f := newPoolPublishFixture(t)
	preparing := true
	setPoolEnqueueCoordinator(t, f.svc, poolEnqueueAdmissionFunc(func(ctx context.Context, taskID string, fn func(context.Context, bool) error) error {
		if taskID != f.task.ID {
			t.Fatal("不能锁错任务")
		}
		return fn(ctx, preparing)
	}))
	ctx := context.Background()
	outcome, row, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if !errors.Is(err, runsmodels.ErrPoolTaskStartPreparing) || row != nil || outcome != runsservice.QueueOutcomeNone {
		t.Fatalf("启动准备中不能新入队: outcome=%s row=%+v err=%v", outcome, row, err)
	}
	var count int
	if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 0 {
		t.Fatalf("被拒绝的发布不能留下运行: count=%d err=%v", count, err)
	}
	select {
	case <-f.svc.SubscribeSignal():
		t.Fatal("拒绝不能唤醒消费者")
	default:
	}
	preparing = false
	outcome, first, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err != nil || first == nil || outcome != runsservice.QueueOutcomeQueued {
		t.Fatalf("启动退出后的正对照应正常发布: %s %+v %v", outcome, first, err)
	}
	<-f.svc.SubscribeSignal()
	preparing = true
	outcome, repeated, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err != nil || repeated == nil || outcome != runsservice.QueueOutcomeDeduped || repeated.ID != first.ID || !repeated.RequestedAt.Equal(first.RequestedAt) {
		t.Fatalf("已有身份重放不能虚报为新的发布拒绝: %s %+v %v", outcome, repeated, err)
	}
}

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolDispatchPublicationRequiresNativeAdmission(t *testing.T) {
	f := newPoolPublishFixture(t)
	setPoolEnqueueCoordinator(t, f.svc, nil)
	outcome, row, err := f.publisher.QueuePoolRunAndReturn(context.Background(), f.task.ID, f.release.EntryID)
	if !errors.Is(err, runsmodels.ErrPoolAdmissionUnavailable) || outcome != runsservice.QueueOutcomeNone || row != nil {
		t.Fatalf("只有批准来源、没有共同准入时不能开放池发布: %s %+v %v", outcome, row, err)
	}
}
