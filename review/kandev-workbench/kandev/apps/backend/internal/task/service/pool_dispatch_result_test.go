package service

import (
	"context"
	"fmt"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
)

type poolQueueResult struct {
	outcome runsservice.QueueOutcome
	row     *runsmodels.Run
}

func (q poolQueueResult) QueuePoolRunAndReturn(context.Context, string, int64) (runsservice.QueueOutcome, *runsmodels.Run, error) {
	return q.outcome, q.row, nil
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolDispatchTaskServiceRejectsUnconfirmedOrMismatchedQueueResult(t *testing.T) {
	cases := []struct {
		name string
		edit func(*poolQueueResult)
	}{
		{"missing_row", func(q *poolQueueResult) { q.row = nil }},
		{"empty_id", func(q *poolQueueResult) { q.row.ID = "" }},
		{"wrong_profile", func(q *poolQueueResult) { q.row.AgentProfileID = "another-profile" }},
		{"wrong_workspace", func(q *poolQueueResult) { q.row.WorkspaceID = "another-workspace" }},
		{"wrong_actor", func(q *poolQueueResult) { q.row.ActorID = "another-human" }},
		{"wrong_payload", func(q *poolQueueResult) { q.row.Payload = `{}` }},
		{"wrong_key", func(q *poolQueueResult) {
			key := runsmodels.PoolDispatchKeyPrefix + "different-entry"
			q.row.IdempotencyKey = &key
		}},
		{"unconfirmed_outcome", func(q *poolQueueResult) { q.outcome = runsservice.QueueOutcomeCoalesced }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newTaskPoolFixture(t)
			ctx := context.Background()
			_, original, err := f.queue.QueuePoolRunAndReturn(ctx, f.task.ID, f.entryID)
			if err != nil || original == nil {
				t.Fatalf("真实队列的正对照应先持久化: %v", err)
			}
			clone := *original
			result := poolQueueResult{outcome: runsservice.QueueOutcomeDeduped, row: &clone}
			tc.edit(&result)
			f.publisher.SetPoolRunQueue(result)
			outcome, err := f.publisher.PublishPoolRelease(ctx, f.task.ID, f.task.WorkflowStepID, fmt.Sprintf("entry:%020d", f.entryID))
			if err == nil || outcome != "" {
				t.Fatalf("任务发布入口不能把错误绑定或不可核验结果报告成功: outcome=%s err=%v", outcome, err)
			}
			stored, err := f.runs.GetRunByID(ctx, original.ID)
			if err != nil || stored.Payload != original.Payload || stored.AgentProfileID != original.AgentProfileID {
				t.Fatalf("发现不一致不能改写原始运行或补造派发: %v", err)
			}
		})
	}
}
