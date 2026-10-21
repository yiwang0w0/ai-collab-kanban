package sqlite_test

import (
	"context"
	"errors"
	"testing"

	"github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolReceiptUnverifiableClaimDoesNotGuess(t *testing.T) {
	for _, ambiguous := range []bool{false, true} {
		name := "missing"
		if ambiguous {
			name = "ambiguous"
		}
		t.Run(name, func(t *testing.T) {
			repo, writer, receipts, identity := poolReceiptFixture(t)
			if ambiguous {
				_, err := writer.Exec(`INSERT INTO office_launch_ledger
					(id, run_id, workspace_id, causation_id, routine_id, human_rooted, claimed_at)
					SELECT 'other-ledger', run_id, workspace_id, causation_id, routine_id, human_rooted, claimed_at
					FROM office_launch_ledger WHERE id = ?`, identity.ClaimID)
				if err != nil {
					t.Fatal(err)
				}
			} else if _, err := writer.Exec(`DELETE FROM office_launch_ledger WHERE id = ?`, identity.ClaimID); err != nil {
				t.Fatal(err)
			}
			if event, err := receipts.AppendPoolExecutionBinding(context.Background(), identity); !errors.Is(err, runssqlite.ErrPoolReceiptUnknown) || event != nil {
				t.Fatalf("不可测或多解账本应未知: %+v, %v", event, err)
			}
			if events, err := repo.ListRunEvents(context.Background(), identity.RunID, -1, 10); err != nil || len(events) != 0 {
				t.Fatalf("不可测不得补造证据: %+v, %v", events, err)
			}
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3
func TestPoolReceiptPersistenceFailureRollsBackBinding(t *testing.T) {
	repo, writer, receipts, identity := poolReceiptFixture(t)
	ctx := context.Background()
	if _, err := writer.Exec(`CREATE TRIGGER reject_pool_receipt BEFORE INSERT ON run_events
		WHEN NEW.event_type = 'pool.execution-bound.v1'
		BEGIN SELECT RAISE(ABORT, 'injected_receipt_failure'); END`); err != nil {
		t.Fatal(err)
	}
	if event, err := receipts.AppendPoolExecutionBinding(ctx, identity); err == nil || event != nil {
		t.Fatalf("写入失败不能返回成功: %+v, %v", event, err)
	}
	run := mustGetRun(t, repo, identity.RunID)
	if run.SessionID != "" || run.Status != models.RunStatusClaimed || run.ClaimedAt == nil {
		t.Fatalf("证据失败不得部分绑定或重新派发: %+v", run)
	}
	if _, err := writer.Exec(`DROP TRIGGER reject_pool_receipt`); err != nil {
		t.Fatal(err)
	}
	// 相同执行补写证据即可，不需要重入队或新领取。
	if _, err := receipts.AppendPoolExecutionBinding(ctx, identity); err != nil {
		t.Fatal(err)
	}
	var claims int
	if err := writer.Get(&claims, `SELECT COUNT(*) FROM office_launch_ledger WHERE run_id = ?`, identity.RunID); err != nil || claims != 1 {
		t.Fatalf("领取数应不变: %d, %v", claims, err)
	}
}

// @covers AC-TASKS-AGENT-POOL-002.2 AC-TASKS-AGENT-POOL-005.4
func TestPoolReceiptRejectsInvalidOrNonPoolIdentity(t *testing.T) {
	repo, writer, receipts, identity := poolReceiptFixture(t)
	ctx := context.Background()
	invalid := identity
	invalid.OperationID = ""
	if event, err := receipts.AppendPoolExecutionBinding(ctx, invalid); err == nil || event != nil {
		t.Fatalf("缺执行身份不得绑定: %+v, %v", event, err)
	}
	if _, err := writer.Exec(`UPDATE runs SET idempotency_key = 'ordinary-run' WHERE id = ?`, identity.RunID); err != nil {
		t.Fatal(err)
	}
	if event, err := receipts.AppendPoolExecutionBinding(ctx, identity); err == nil || event != nil {
		t.Fatalf("普通运行不能伪造池领取: %+v, %v", event, err)
	}
	if events, err := repo.ListRunEvents(ctx, identity.RunID, -1, 10); err != nil || len(events) != 0 {
		t.Fatalf("拒绝后不得留下回执: %+v, %v", events, err)
	}
}

// @covers AC-TASKS-AGENT-POOL-002.3
func TestPoolReceiptLateActivityDoesNotReviveTerminalRun(t *testing.T) {
	repo, writer, receipts, identity := poolReceiptFixture(t)
	ctx := context.Background()
	if _, err := receipts.AppendPoolExecutionBinding(ctx, identity); err != nil {
		t.Fatal(err)
	}
	// 只构造已终结的持久夹具，不把被禁用的通用终结当作池停止／恢复证明。
	if _, err := writer.Exec(`UPDATE runs SET status = 'finished', finished_at = CURRENT_TIMESTAMP WHERE id = ?`, identity.RunID); err != nil {
		t.Fatal(err)
	}
	if event, err := receipts.AppendPoolWorkObserved(ctx, identity, models.PoolStartTool); err == nil || event != nil {
		t.Fatalf("晚到活动不得复活已终结执行: %+v, %v", event, err)
	}
	if run := mustGetRun(t, repo, identity.RunID); run.Status != models.RunStatusFinished {
		t.Fatalf("终结状态被改写: %+v", run)
	}
}
