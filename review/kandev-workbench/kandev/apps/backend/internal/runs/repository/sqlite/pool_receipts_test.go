package sqlite_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
)

type poolReceiptWriter interface {
	AppendPoolExecutionBinding(context.Context, models.PoolExecutionIdentity) (*models.RunEvent, error)
	AppendPoolWorkObserved(context.Context, models.PoolExecutionIdentity, models.PoolStartSource) (*models.RunEvent, error)
}

func poolReceiptFixture(t *testing.T) (*runssqlite.Repository, *sqlx.DB, poolReceiptWriter, models.PoolExecutionIdentity) {
	t.Helper()
	repo, writer := newTestRepoWithDB(t)
	receipts, ok := any(repo).(poolReceiptWriter)
	if !ok {
		t.Fatal("缺少按当前领取校验并事务追加的任务池回执入口")
	}
	seedClaimAgent(t, repo, "pool-agent")
	key := models.PoolDispatchKeyPrefix + "host-generated-stage-entry"
	mustCreateRun(t, repo, &models.Run{
		ID: "pool-run", AgentProfileID: "pool-agent", WorkspaceID: claimTestWorkspace("pool-agent"),
		Payload: `{"task_id":"pool-task","workflow_step_id":"implementation"}`,
		Status:  "queued", Reason: "pool_dispatch", IdempotencyKey: &key,
	})
	claim, err := repo.ClaimNextEligibleRunWithClaim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	identity := models.PoolExecutionIdentity{
		RunID: claim.ID, ClaimID: claim.ClaimID, TaskID: "pool-task", AgentProfileID: "pool-agent",
		ExecutionProfileID: "pool-agent", SessionID: "session-current", ExecutionID: "execution-current",
		TurnID: "turn-current", OperationID: "operation-current", PromptGeneration: 1,
	}
	return repo, writer, receipts, identity
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.2
func TestPoolReceiptBindingAndObservedWork(t *testing.T) {
	repo, _, receipts, identity := poolReceiptFixture(t)
	ctx := context.Background()
	if event, err := receipts.AppendPoolWorkObserved(ctx, identity, models.PoolStartAssistant); err == nil || event != nil {
		t.Fatalf("未绑定执行不得开工: %+v, %v", event, err)
	}
	before := time.Now().UTC()
	bound, err := receipts.AppendPoolExecutionBinding(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	started, err := receipts.AppendPoolWorkObserved(ctx, identity, models.PoolStartAssistant)
	if err != nil {
		t.Fatal(err)
	}
	var payload models.PoolWorkReceipt
	if err := json.Unmarshal([]byte(started.Payload), &payload); err != nil {
		t.Fatal(err)
	}
	if bound.EventType != models.PoolExecutionBound || started.EventType != models.PoolWorkObserved ||
		started.Seq != bound.Seq+1 || payload.PoolExecutionIdentity != identity ||
		payload.StartedSource != models.PoolStartAssistant || started.CreatedAt.Before(before) {
		t.Fatalf("开工证据未保留真实绑定: bound=%+v started=%+v payload=%+v", bound, started, payload)
	}
	if run := mustGetRun(t, repo, identity.RunID); run.Status != models.RunStatusClaimed || run.FinishedAt != nil {
		t.Fatalf("开工回执不能完成运行或任务: %+v", run)
	}
}

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-002.3
func TestPoolReceiptReplayAndIdentityFencing(t *testing.T) {
	repo, _, receipts, identity := poolReceiptFixture(t)
	ctx := context.Background()
	bound, err := receipts.AppendPoolExecutionBinding(ctx, identity)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := receipts.AppendPoolExecutionBinding(ctx, identity)
	if err != nil || replay.Seq != bound.Seq || !replay.CreatedAt.Equal(bound.CreatedAt) {
		t.Fatalf("重复绑定应返回原回执: %+v, %v", replay, err)
	}
	cases := []struct {
		name  string
		alter func(*models.PoolExecutionIdentity)
	}{
		{"claim", func(i *models.PoolExecutionIdentity) { i.ClaimID = "old-claim" }},
		{"task", func(i *models.PoolExecutionIdentity) { i.TaskID = "other-task" }},
		{"agent", func(i *models.PoolExecutionIdentity) { i.AgentProfileID = "other-agent" }},
		{"profile", func(i *models.PoolExecutionIdentity) { i.ExecutionProfileID = "other-profile" }},
		{"session", func(i *models.PoolExecutionIdentity) { i.SessionID = "other-session" }},
		{"execution", func(i *models.PoolExecutionIdentity) { i.ExecutionID = "old-execution" }},
		{"turn", func(i *models.PoolExecutionIdentity) { i.TurnID = "old-turn" }},
		{"operation", func(i *models.PoolExecutionIdentity) { i.OperationID = "old-operation" }},
		{"generation", func(i *models.PoolExecutionIdentity) { i.PromptGeneration++ }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wrong := identity
			tc.alter(&wrong)
			if event, err := receipts.AppendPoolWorkObserved(ctx, wrong, models.PoolStartTool); err == nil || event != nil {
				t.Fatalf("不匹配的执行身份不得写回执: %+v, %v", event, err)
			}
			if event, err := receipts.AppendPoolExecutionBinding(ctx, wrong); err == nil || event != nil {
				t.Fatalf("已有绑定不可换身份: %+v, %v", event, err)
			}
		})
	}
	if event, err := receipts.AppendPoolWorkObserved(ctx, identity, "turn_started"); err == nil || event != nil {
		t.Fatalf("公共 turn_started 不是可信开工来源: %+v, %v", event, err)
	}
	// 显式构造旧版本／人工恢复后的替换行；通用重入队现已拒绝池运行。
	if _, err := repo.Writer().Exec(`UPDATE runs SET status = 'queued', claimed_at = NULL WHERE id = ?`, identity.RunID); err != nil {
		t.Fatal(err)
	}
	newClaim, err := repo.ClaimNextEligibleRunWithClaim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if event, err := receipts.AppendPoolWorkObserved(ctx, identity, models.PoolStartTool); err == nil || event != nil {
		t.Fatalf("旧领取不得覆盖新领取: %+v, %v", event, err)
	}
	identity.ClaimID = newClaim.ClaimID
	identity.SessionID = "session-new"
	if _, err := receipts.AppendPoolExecutionBinding(ctx, identity); err != nil {
		t.Fatal(err)
	}
	events, err := repo.ListRunEvents(ctx, identity.RunID, -1, 10)
	if err != nil || len(events) != 2 {
		t.Fatalf("应保留两轮独立绑定历史: %d, %v", len(events), err)
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3
func TestPoolReceiptConcurrentReplay(t *testing.T) {
	repo, _, receipts, identity := poolReceiptFixture(t)
	ctx := context.Background()
	if _, err := receipts.AppendPoolExecutionBinding(ctx, identity); err != nil {
		t.Fatal(err)
	}
	const writers = 12
	start := make(chan struct{})
	errs := make(chan error, writers)
	var wg sync.WaitGroup
	for n := 0; n < writers; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := receipts.AppendPoolWorkObserved(ctx, identity, models.PoolStartCodexProvider)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	events, err := repo.ListRunEvents(ctx, identity.RunID, -1, 10)
	if err != nil || len(events) != 2 || events[0].Seq != 0 || events[1].Seq != 1 {
		t.Fatalf("并发重放只能保留一份绑定与首次开工: %+v, %v", events, err)
	}
	first := events[1]
	replay, err := receipts.AppendPoolWorkObserved(ctx, identity, models.PoolStartTool)
	if err != nil || replay.Seq != first.Seq || replay.Payload != first.Payload || !replay.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("其他活动不得改写首次开工: %+v, %v", replay, err)
	}
}
