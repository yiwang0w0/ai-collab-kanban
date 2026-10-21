package service_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
)

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolDispatchPublicationConcurrentReplayHasOneRowAndSignal(t *testing.T) {
	f := newPoolPublishFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	const callers = 12
	type result struct {
		outcome runsservice.QueueOutcome
		row     *runsmodels.Run
		err     error
	}
	start := make(chan struct{})
	results := make(chan result, callers)
	for range callers {
		go func() {
			<-start
			outcome, row, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
			results <- result{outcome, row, err}
		}()
	}
	close(start)
	queued, deduped := 0, 0
	var runID string
	for range callers {
		result := <-results
		if result.err != nil || result.row == nil {
			t.Errorf("竞争重放不得遗失真实运行: outcome=%s err=%v", result.outcome, result.err)
			continue
		}
		if runID == "" {
			runID = result.row.ID
		}
		if runID != result.row.ID {
			t.Errorf("竞争请求必须解析同一持久运行: got=%s want=%s", result.row.ID, runID)
		}
		switch result.outcome {
		case runsservice.QueueOutcomeQueued:
			queued++
		case runsservice.QueueOutcomeDeduped:
			deduped++
		default:
			t.Errorf("竞争池请求不能合并或丢弃: %s", result.outcome)
		}
	}
	if queued != 1 || deduped != callers-1 {
		t.Fatalf("只能有一份逻辑派发: queued=%d deduped=%d", queued, deduped)
	}
	var count int
	if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 1 {
		t.Fatalf("实际数据库必须只有一行: %d %v", count, err)
	}
	<-f.svc.SubscribeSignal()
	select {
	case <-f.svc.SubscribeSignal():
		t.Fatal("竞争重放只能产生一次调度信号")
	default:
	}
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(ctx)
	if err != nil || claim == nil || claim.ID != runID || claim.ClaimID == "" {
		t.Fatalf("唯一运行应可沿原生原子领取: %+v %v", claim, err)
	}
	if duplicate, err := f.runs.ClaimNextEligibleRunWithClaim(ctx); !errors.Is(err, sql.ErrNoRows) || duplicate != nil {
		t.Fatalf("没有第二份可领取的派发: %+v %v", duplicate, err)
	}
}
