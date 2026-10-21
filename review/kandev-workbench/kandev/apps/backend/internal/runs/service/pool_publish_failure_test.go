package service_test

import (
	"context"
	"testing"
	"time"

	runsservice "github.com/kandev/kandev/internal/runs/service"
)

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-002.1
func TestPoolDispatchPublicationDedupesPersistedIdentityBeyondNotificationWindow(t *testing.T) {
	f := newPoolPublishFixture(t)
	ctx := context.Background()
	_, original, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err != nil || original == nil {
		t.Fatal(err)
	}
	<-f.svc.SubscribeSignal()
	oldTime := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if _, err := f.runs.Writer().Exec(`UPDATE runs SET requested_at = ? WHERE id = ?`, oldTime, original.ID); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		outcome, replay, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
		if err != nil || outcome != runsservice.QueueOutcomeDeduped || replay == nil || replay.ID != original.ID || !replay.RequestedAt.Equal(oldTime) {
			t.Fatalf("24 小时之外也不能创造第二条派发或重写时间: %s %v", outcome, err)
		}
	}
	select {
	case <-f.svc.SubscribeSignal():
		t.Fatal("旧身份重放不能再唤醒执行")
	default:
	}
}

func TestPoolDispatchPublicationWriteFailureRollsBackAndDoesNotSignal(t *testing.T) {
	f := newPoolPublishFixture(t)
	ctx := context.Background()
	if _, err := f.runs.Writer().Exec(`CREATE TRIGGER reject_pool_queue BEFORE INSERT ON runs
		WHEN NEW.reason = 'pool_dispatch' BEGIN SELECT RAISE(ABORT, 'pool_queue_write_rejected'); END`); err != nil {
		t.Fatal(err)
	}
	outcome, row, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err == nil || row != nil || outcome != "" {
		t.Fatalf("插入失败不能返回派发成功: %s %v", outcome, err)
	}
	var count int
	if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 0 {
		t.Fatalf("插入失败必须整体回滚: %d %v", count, err)
	}
	select {
	case <-f.svc.SubscribeSignal():
		t.Fatal("插入失败不能调用消费者")
	default:
	}
	if _, err := f.runs.Writer().Exec(`DROP TRIGGER reject_pool_queue`); err != nil {
		t.Fatal(err)
	}
	if outcome, row, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID); err != nil || row == nil || outcome != runsservice.QueueOutcomeQueued {
		t.Fatalf("失败不能消耗批准或幂等键；明确重放的正对照应可入队: %s %v", outcome, err)
	}
}

func TestPoolDispatchPublicationDoesNotGuessAnAmbiguousPersistedKey(t *testing.T) {
	f := newPoolPublishFixture(t)
	ctx := context.Background()
	_, original, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err != nil || original == nil {
		t.Fatal(err)
	}
	<-f.svc.SubscribeSignal()
	if _, err := f.runs.Writer().Exec(`DROP INDEX idx_run_idempotency`); err != nil {
		t.Fatal(err)
	}
	duplicate := *original
	duplicate.ID = "ambiguous-pool-row"
	if err := f.runs.CreateRun(ctx, &duplicate); err != nil {
		t.Fatal(err)
	}
	outcome, row, err := f.publisher.QueuePoolRunAndReturn(ctx, f.task.ID, f.release.EntryID)
	if err == nil || row != nil || outcome != "" {
		t.Fatalf("底层唯一性不可核验时不能挑第一行报告成功: %s %t %v", outcome, row != nil, err)
	}
	var count int
	if err := f.runs.Reader().Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 2 {
		t.Fatalf("歧义不能清理或补造任何运行: %d %v", count, err)
	}
	select {
	case <-f.svc.SubscribeSignal():
		t.Fatal("歧义不能再次发出执行信号")
	default:
	}
}
