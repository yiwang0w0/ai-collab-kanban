package service_test

import (
	"context"
	"errors"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
)

type poolReleaseOnlySource struct{ runsservice.PoolReleaseSource }

// @covers AC-TASKS-AGENT-POOL-001.1
func TestPoolClaimStartAdmissionRequiresCompleteNativeComposition(t *testing.T) {
	for _, incomplete := range []string{"claim_readiness_missing", "coordinator_missing"} {
		t.Run(incomplete, func(t *testing.T) {
			f, claim := claimedPoolFixture(t)
			request := poolClaimRequest(t, claim)
			if incomplete == "claim_readiness_missing" {
				f.svc.SetPoolReleaseSource(poolReleaseOnlySource{PoolReleaseSource: f.tasks})
			} else {
				f.svc.SetPoolEnqueueAdmission(nil)
			}
			if err := f.svc.AdmitPoolClaimStart(context.Background(), request); !errors.Is(err, runsmodels.ErrPoolAdmissionUnavailable) {
				t.Fatalf("不能把缺少可选能力的对象当成已核验领取: %v", err)
			}
			var intents int
			if err := f.runs.Reader().Get(&intents, `SELECT COUNT(*) FROM run_events WHERE run_id = ?`, claim.ID); err != nil || intents != 0 {
				t.Fatalf("未接齐能力时不能签发启动意图: count=%d err=%v", intents, err)
			}
		})
	}
}
