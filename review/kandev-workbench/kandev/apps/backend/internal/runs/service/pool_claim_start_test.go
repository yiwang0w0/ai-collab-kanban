package service_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

type poolClaimStartSource interface {
	PoolStartRequest() (runsmodels.PoolClaimStart, error)
}

type poolClaimStartAdmitter interface {
	AdmitPoolClaimStart(context.Context, runsmodels.PoolClaimStart) error
}

func poolClaimRequest(t *testing.T, claim *runsmodels.ClaimedRun) runsmodels.PoolClaimStart {
	t.Helper()
	source, ok := any(claim).(poolClaimStartSource)
	if !ok {
		t.Fatal("领取快照尚不能提取受约束的宿主启动身份")
	}
	request, err := source.PoolStartRequest()
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func claimedPoolFixture(t *testing.T) (poolPublishFixture, *runsmodels.ClaimedRun) {
	t.Helper()
	f := newPoolPublishFixture(t)
	if _, _, err := f.publisher.QueuePoolRunAndReturn(context.Background(), f.task.ID, f.release.EntryID); err != nil {
		t.Fatal(err)
	}
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(context.Background())
	if err != nil || claim == nil {
		t.Fatalf("必须从原生领取事务取得身份: %+v %v", claim, err)
	}
	return f, claim
}

// @covers AC-TASKS-AGENT-POOL-002.1
func TestPoolClaimStartRequestUsesNativeImmutableProducerBinding(t *testing.T) {
	f, claim := claimedPoolFixture(t)
	request := poolClaimRequest(t, claim)
	if request.RunID != claim.ID || request.ClaimID != claim.ClaimID || request.Release != f.release {
		t.Fatalf("启动身份必须保留实际领取及批准绑定: %+v", request)
	}
	for _, mutate := range []func(*runsmodels.ClaimedRun){
		func(c *runsmodels.ClaimedRun) { c.ClaimID = "" },
		func(c *runsmodels.ClaimedRun) { c.ClaimID = " claim-with-space " },
		func(c *runsmodels.ClaimedRun) { c.Run = nil },
		func(c *runsmodels.ClaimedRun) { c.ClaimedAt = nil },
		func(c *runsmodels.ClaimedRun) { c.Status = runsmodels.RunStatusQueued },
		func(c *runsmodels.ClaimedRun) { c.AgentProfileID = "wrong-profile" },
		func(c *runsmodels.ClaimedRun) { c.Payload = `{ "task_id": "other-task" }` },
	} {
		copyRun := *claim.Run
		copyClaim := &runsmodels.ClaimedRun{Run: &copyRun, ClaimID: claim.ClaimID}
		mutate(copyClaim)
		_, err := any(copyClaim).(poolClaimStartSource).PoolStartRequest()
		if !errors.Is(err, runsmodels.ErrPoolClaimStartConflict) {
			t.Fatalf("无效领取不能提取启动许可: %+v err=%v", copyClaim, err)
		}
	}
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-005.1
func TestPoolClaimStartAdmissionIsDurableOneShotNotWorkEvidence(t *testing.T) {
	f, claim := claimedPoolFixture(t)
	admitter, ok := any(f.svc).(poolClaimStartAdmitter)
	if !ok {
		t.Fatal("缺少真实 claim 的持久启动准入")
	}
	request := runsmodels.PoolClaimStart{RunID: claim.ID, ClaimID: claim.ClaimID, Release: f.release}
	if err := admitter.AdmitPoolClaimStart(context.Background(), request); err != nil {
		t.Fatalf("当前唯一领取应可登记一次启动意图: %v", err)
	}
	if err := admitter.AdmitPoolClaimStart(context.Background(), request); !errors.Is(err, runsmodels.ErrPoolLaunchAlreadyAdmitted) {
		t.Fatalf("同一 claim 的重放不能再次取得启动许可: %v", err)
	}
	var events []runsmodels.RunEvent
	if err := f.runs.Reader().Select(&events, `SELECT * FROM run_events WHERE run_id = ? ORDER BY seq`, claim.ID); err != nil {
		t.Fatal(err)
	}
	var stored runsmodels.PoolClaimStart
	if len(events) != 1 || events[0].EventType != "pool.launch-admitted.v1" || json.Unmarshal([]byte(events[0].Payload), &stored) != nil || stored != request {
		t.Fatalf("应仅追加一份启动意图，不冒充开工或执行绑定: %+v", events)
	}
	current, err := f.runs.GetRunByID(context.Background(), claim.ID)
	if err != nil || current.Status != runsmodels.RunStatusClaimed || current.SessionID != "" {
		t.Fatalf("启动意图不能绑定虚构会话或完成运行: %+v %v", current, err)
	}
}
