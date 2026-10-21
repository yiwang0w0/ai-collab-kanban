package service_test

import (
	"context"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	taskmodels "github.com/kandev/kandev/internal/task/models"
)

func poolClaimFixtureSQL(t *testing.T, f poolPublishFixture, query string, args ...any) {
	t.Helper()
	if _, err := f.runs.Writer().Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

type poolClaimRefusalCase struct {
	name string
	seed func(*testing.T, poolPublishFixture, *runsmodels.PoolClaimStart)
}

func poolClaimRefusalCases() []poolClaimRefusalCase {
	return []poolClaimRefusalCase{
		{"wrong_claim", func(_ *testing.T, _ poolPublishFixture, p *runsmodels.PoolClaimStart) { p.ClaimID = "stale-claim" }},
		{"wrong_release", func(_ *testing.T, _ poolPublishFixture, p *runsmodels.PoolClaimStart) {
			p.Release.ActorID = "forged-actor"
		}},
		{"claim_ledger_missing", func(t *testing.T, f poolPublishFixture, p *runsmodels.PoolClaimStart) {
			poolClaimFixtureSQL(t, f, `DELETE FROM office_launch_ledger WHERE run_id = ?`, p.RunID)
		}},
		{"claim_ledger_ambiguous", func(t *testing.T, f poolPublishFixture, p *runsmodels.PoolClaimStart) {
			poolClaimFixtureSQL(t, f, `INSERT INTO office_launch_ledger (id, run_id, workspace_id, causation_id, routine_id, human_rooted, claimed_at)
				SELECT 'duplicate-claim', run_id, workspace_id, causation_id, routine_id, human_rooted, claimed_at FROM office_launch_ledger WHERE run_id = ?`, p.RunID)
		}},
		{"terminal_run", func(t *testing.T, f poolPublishFixture, p *runsmodels.PoolClaimStart) {
			poolClaimFixtureSQL(t, f, `UPDATE runs SET status = 'failed' WHERE id = ?`, p.RunID)
		}},
		{"prior_unconfirmed_session", func(t *testing.T, f poolPublishFixture, p *runsmodels.PoolClaimStart) {
			poolClaimFixtureSQL(t, f, `UPDATE runs SET session_id = 'unknown-prior-session' WHERE id = ?`, p.RunID)
		}},
		{"profile_changed_after_claim", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart) {
			poolClaimFixtureSQL(t, f, `UPDATE agent_profiles SET provider_kind = 'openai_compatible' WHERE id = ?`, f.step.AgentProfileID)
		}},
		{"dependency_added_after_claim", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart) {
			poolClaimFixtureSQL(t, f, `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, 'missing-blocker', ?)`, f.task.ID, f.release.ReleasedAt)
		}},
		{"active_native_session", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart) {
			if err := f.tasks.CreateTaskSession(context.Background(), &taskmodels.TaskSession{ID: "active-session", TaskID: f.task.ID,
				AgentProfileID: f.step.AgentProfileID, State: taskmodels.TaskSessionStateStarting}); err != nil {
				t.Fatal(err)
			}
		}},
		{"another_pool_run", func(t *testing.T, f poolPublishFixture, _ *runsmodels.PoolClaimStart) {
			key := runsmodels.PoolDispatchKeyPrefix + "legacy-other-run"
			if err := f.runs.CreateRun(context.Background(), &runsmodels.Run{ID: "other-active-run", AgentProfileID: f.step.AgentProfileID,
				WorkspaceID: f.task.WorkspaceID, Status: runsmodels.RunStatusQueued, IdempotencyKey: &key,
				Payload: `{"task_id":"` + f.task.ID + `"}`}); err != nil {
				t.Fatal(err)
			}
		}},
	}
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.2 AC-TASKS-AGENT-POOL-002.1
func TestPoolClaimStartAdmissionRechecksCurrentClaimAndNativeReadiness(t *testing.T) {
	for _, tc := range poolClaimRefusalCases() {
		t.Run(tc.name, func(t *testing.T) {
			f, claim := claimedPoolFixture(t)
			admitter, ok := any(f.svc).(poolClaimStartAdmitter)
			if !ok {
				t.Fatal("没有真实 claim 启动门禁")
			}
			request := runsmodels.PoolClaimStart{RunID: claim.ID, ClaimID: claim.ClaimID, Release: f.release}
			tc.seed(t, f, &request)
			if err := admitter.AdmitPoolClaimStart(context.Background(), request); err == nil {
				t.Fatal("领取本身不能绕过当前资格、原生活动或不可变身份")
			}
			var intents int
			if err := f.runs.Reader().Get(&intents, `SELECT COUNT(*) FROM run_events WHERE run_id = ?`, claim.ID); err != nil || intents != 0 {
				t.Fatalf("未获准不能留下启动意图或开工回执: count=%d err=%v", intents, err)
			}
		})
	}
}
