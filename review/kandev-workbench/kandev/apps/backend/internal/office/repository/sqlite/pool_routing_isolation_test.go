package sqlite_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/office/repository/sqlite"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

// @covers AC-TASKS-AGENT-POOL-005.2 AC-TASKS-AGENT-POOL-002.3
func TestPoolRoutingRecoveryIsolation(t *testing.T) {
	for _, action := range []string{"park", "next-candidate", "workspace-unpark"} {
		for _, key := range []string{"", "office:pool-dispatch:v1:ordinary", runsmodels.PoolDispatchKeyPrefix, runsmodels.PoolDispatchKeyPrefix + "entry"} {
			t.Run(action+"/"+key, func(t *testing.T) {
				repo, db := newTestRepoWithDB(t)
				seedAgentProfile(t, db, "profile", "workspace")
				run := &runsmodels.Run{ID: "run", AgentProfileID: "profile", Reason: "task_assigned",
					Payload: `{}`, Status: "claimed", SessionID: "original-session", CoalescedCount: 1}
				if key != "" {
					run.IdempotencyKey = &key
				}
				ctx := context.Background()
				if err := repo.CreateRun(ctx, run); err != nil {
					t.Fatal(err)
				}
				claimed := time.Date(2026, 10, 20, 1, 0, 0, 0, time.UTC)
				if _, err := db.Exec(`UPDATE runs SET claimed_at=?, routing_blocked_status='waiting_for_provider_capacity', earliest_retry_at=?, scheduled_retry_at=? WHERE id=?`,
					claimed, claimed.Add(time.Hour), claimed.Add(time.Hour), run.ID); err != nil {
					t.Fatal(err)
				}
				before, err := repo.GetRunByID(ctx, run.ID)
				if err != nil {
					t.Fatal(err)
				}
				applyPoolRoutingAction(t, repo, action, claimed.Add(2*time.Hour))
				after, err := repo.GetRunByID(ctx, run.ID)
				if err != nil {
					t.Fatal(err)
				}
				protected := key == runsmodels.PoolDispatchKeyPrefix || key == runsmodels.PoolDispatchKeyPrefix+"entry"
				if protected && !reflect.DeepEqual(before, after) {
					t.Fatalf("旧路由 %s 不得重排池领取：before=%+v after=%+v", action, before, after)
				}
				if !protected && (after.Status != "queued" || reflect.DeepEqual(before, after)) {
					t.Fatalf("相同入口应继续重排普通运行：%+v", after)
				}
			})
		}
	}
}

func applyPoolRoutingAction(t *testing.T, repo *sqlite.Repository, action string, retryAt time.Time) {
	t.Helper()
	ctx := context.Background()
	var err error
	switch action {
	case "park":
		err = repo.ParkRunForProviderCapacity(ctx, "run", "provider_degraded", retryAt)
	case "next-candidate":
		err = repo.RequeueRunForNextCandidate(ctx, "run")
	case "workspace-unpark":
		err = repo.ClearAllParkedRoutingForWorkspace(ctx, "workspace")
	default:
		t.Fatalf("未知路由动作：%s", action)
	}
	if err != nil {
		t.Fatal(err)
	}
}
