package sqlite_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/runs/models"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
)

type claimWithIdentity interface {
	ClaimNextEligibleRunWithClaim(context.Context) (*models.ClaimedRun, error)
}

type currentPoolClaimReader interface {
	ResolveCurrentPoolClaim(context.Context, string) (*models.ClaimedRun, error)
}

// @covers AC-TASKS-AGENT-POOL-002.3
func TestPoolClaimReconstructionRequiresUniqueLedger(t *testing.T) {
	repo, writer, _, identity := poolReceiptFixture(t)
	ctx := context.Background()
	reconstructed := runssqlite.NewWithDB(writer, repo.Reader())
	reader, ok := any(reconstructed).(currentPoolClaimReader)
	if !ok {
		t.Fatal("缺少仅按唯一当前账本重建领取的只读入口")
	}
	claim, err := reader.ResolveCurrentPoolClaim(ctx, identity.RunID)
	if err != nil || claim == nil || claim.ClaimID != identity.ClaimID {
		t.Fatalf("重建领取 = %+v, %v", claim, err)
	}
	if _, err := writer.Exec(`INSERT INTO office_launch_ledger
		(id, run_id, workspace_id, causation_id, routine_id, human_rooted, claimed_at)
		SELECT 'ambiguous-claim', run_id, workspace_id, causation_id, routine_id, human_rooted, claimed_at
		FROM office_launch_ledger WHERE id = ?`, identity.ClaimID); err != nil {
		t.Fatal(err)
	}
	if claim, err := reader.ResolveCurrentPoolClaim(ctx, identity.RunID); !errors.Is(err, runssqlite.ErrPoolReceiptUnknown) || claim != nil {
		t.Fatalf("多解不得选最大 ID 猜测: %+v, %v", claim, err)
	}
	if _, err := writer.Exec(`DELETE FROM office_launch_ledger WHERE run_id = ?`, identity.RunID); err != nil {
		t.Fatal(err)
	}
	if claim, err := reader.ResolveCurrentPoolClaim(ctx, identity.RunID); !errors.Is(err, runssqlite.ErrPoolReceiptUnknown) || claim != nil {
		t.Fatalf("缺失账本不得补造: %+v, %v", claim, err)
	}
	if run := mustGetRun(t, repo, identity.RunID); run.Status != models.RunStatusClaimed || run.ClaimedAt == nil {
		t.Fatalf("重建查询不得重新派发: %+v", run)
	}
}

// @covers AC-TASKS-AGENT-POOL-002.1
func TestPoolClaimReturnsCommittedLedgerIdentity(t *testing.T) {
	repo, writer := newTestRepoWithDB(t)
	claimer, ok := any(repo).(claimWithIdentity)
	if !ok {
		t.Fatal("领取入口未返回同事务写入的账本身份")
	}
	seedClaimAgent(t, repo, "pool-agent")
	run := queueRunAt(t, repo, "pool-run", "pool-agent", time.Now().UTC())
	ctx := context.Background()
	first, err := claimer.ClaimNextEligibleRunWithClaim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ledgerID string
	if err := writer.Get(&ledgerID, `SELECT id FROM office_launch_ledger WHERE run_id = ? AND claimed_at = ?`, run.ID, *first.ClaimedAt); err != nil {
		t.Fatal(err)
	}
	if first.ClaimID == "" || first.ClaimID != ledgerID || first.ID != run.ID {
		t.Fatalf("领取身份 = %+v，账本 = %q", first, ledgerID)
	}
	if changed, err := repo.RequeueClaimedRun(ctx, run.ID); err != nil || !changed {
		t.Fatalf("重入队 = %v, %v", changed, err)
	}
	second, err := claimer.ClaimNextEligibleRunWithClaim(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second.ClaimID == "" || second.ClaimID == first.ClaimID || second.RetryCount != first.RetryCount {
		t.Fatalf("新领取必须有不同身份且不依赖重试计数: first=%+v second=%+v", first, second)
	}
	var ledgerCount int
	if err := writer.Get(&ledgerCount, `SELECT COUNT(*) FROM office_launch_ledger WHERE run_id = ?`, run.ID); err != nil || ledgerCount != 2 {
		t.Fatalf("历史领取数 = %d, %v", ledgerCount, err)
	}
	if empty, err := claimer.ClaimNextEligibleRunWithClaim(ctx); !errors.Is(err, sql.ErrNoRows) || empty != nil {
		t.Fatalf("无资格工作时不得返回账本身份: %+v, %v", empty, err)
	}
}
