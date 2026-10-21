package service_test

import (
	"context"
	"testing"

	"github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
)

// @covers AC-TASKS-AGENT-POOL-005.4
func TestPoolDispatchReservedNamespaceIsNotAnAuthoredQueueKey(t *testing.T) {
	svc, _, repo := newTestServiceWithRepo(t)
	seedAgentProfile(t, repo.Writer(), "fixed-cli")
	ctx := context.Background()
	req := runsservice.QueueRunRequest{
		AgentProfileID: "fixed-cli", Reason: "explicit_queue", IdempotencyKey: "ordinary-key",
		ActorKind: models.ActorKindUser, ActorID: "human", SkipCoalesce: true,
	}
	if outcome, run, err := svc.QueueRunAndReturn(ctx, req); err != nil || run == nil || outcome != runsservice.QueueOutcomeQueued {
		t.Fatalf("正对照应可正常入队: %s %+v %v", outcome, run, err)
	}
	<-svc.SubscribeSignal()
	req.IdempotencyKey = models.PoolDispatchKeyPrefix + "untrusted-entry"
	req.Payload = map[string]any{"pool": true, "claim_id": "self-reported", "started_at": "self-reported"}
	if outcome, run, err := svc.QueueRunAndReturn(ctx, req); err == nil || run != nil || outcome != runsservice.QueueOutcomeNone {
		t.Fatalf("自报保留键不得成为池运行: %s %+v %v", outcome, run, err)
	}
	if outcome, err := svc.QueueRun(ctx, req); err == nil || outcome != runsservice.QueueOutcomeNone {
		t.Fatalf("兼容入队入口也必须拒绝: %s %v", outcome, err)
	}
	var count int
	if err := repo.Writer().Get(&count, `SELECT COUNT(*) FROM runs`); err != nil || count != 1 {
		t.Fatalf("拒绝后只能保留正对照: count=%d err=%v", count, err)
	}
	select {
	case <-svc.SubscribeSignal():
		t.Fatal("拒绝后不得唤醒消费者")
	default:
	}
}
