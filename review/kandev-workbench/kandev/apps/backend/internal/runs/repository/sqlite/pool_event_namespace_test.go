package sqlite_test

import (
	"context"
	"errors"
	"testing"

	"github.com/kandev/kandev/internal/runs/models"
)

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.2
func TestPoolEvidenceCannotBeWrittenThroughGenericRunEvents(t *testing.T) {
	repo, _, receipts, identity := poolReceiptFixture(t)
	ctx := context.Background()
	mustCreateRun(t, repo, &models.Run{ID: "ordinary-event-run", AgentProfileID: identity.AgentProfileID,
		WorkspaceID: claimTestWorkspace(identity.AgentProfileID), Status: models.RunStatusQueued, Payload: "{}"})
	for _, runID := range []string{identity.RunID, "ordinary-event-run"} {
		for _, kind := range []string{models.PoolLaunchAdmitted, models.PoolExecutionBound, models.PoolWorkObserved, "pool.future-proof.v2"} {
			event, err := repo.AppendRunEvent(ctx, runID, kind, "info", `{"forged":true}`)
			if !errors.Is(err, models.ErrReservedPoolEventType) || event != nil {
				t.Fatalf("普通事件入口不能签发宿主池证据: run=%s type=%s event=%+v err=%v", runID, kind, event, err)
			}
		}
		events, err := repo.ListRunEvents(ctx, runID, -1, 10)
		if err != nil || len(events) != 0 {
			t.Fatalf("被拒绝的保留事件不能持久化: events=%+v err=%v", events, err)
		}
		ordinary, err := repo.AppendRunEvent(ctx, runID, "step", "", `{"event_type":"pool.work-observed.v1"}`)
		if err != nil || ordinary == nil || ordinary.EventType != "step" || ordinary.Seq != 0 {
			t.Fatalf("普通事件及原序号不能被池命名空间门禁改变: %+v %v", ordinary, err)
		}
	}
	bound, err := receipts.AppendPoolExecutionBinding(ctx, identity)
	if err != nil || bound.Seq != 1 {
		t.Fatalf("专用宿主绑定方法仍应工作: %+v %v", bound, err)
	}
	work, err := receipts.AppendPoolWorkObserved(ctx, identity, models.PoolStartTool)
	if err != nil || work.Seq != 2 {
		t.Fatalf("专用宿主工作回执仍应工作: %+v %v", work, err)
	}
}
