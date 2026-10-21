package handlers

import (
	"context"
	"fmt"
	"testing"

	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolHistoryNativeQueryBudgetStaysFlatAcrossFiftyClaims(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	runID := ""
	for i := 0; i < poolhistory.MaxItems; i++ {
		if i != 0 {
			// 仅重置从未调用执行器的测试运行，历史身份仍由原生领取事务生成。
			_, err := f.database.Exec(`UPDATE runs SET status='queued',claimed_at=NULL WHERE id=?`, runID)
			require.NoError(t, err)
		}
		claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
		require.NoError(t, err)
		require.NotNil(t, claim)
		runID = claim.ID
	}
	repo, counter := newPoolProjectionCountingReader(t, f)
	before := poolHistorySourceCounts(t, f)
	require.Equal(t, 1, before.Counts[0])
	require.Equal(t, poolhistory.MaxItems, before.Counts[2])
	counts := make(map[int]int)
	for _, limit := range []int{1, poolhistory.MaxItems} {
		counts[limit] = measurePoolProjectionBudget(t, counter, fmt.Sprintf("%d 项领取历史", limit), func(ctx context.Context) error {
			snapshot, err := repo.ReadPoolHistorySnapshot(ctx, f.task.ID, f.task.WorkspaceID, poolhistory.Query{Limit: limit})
			if err == nil {
				page, projectionError := poolhistory.Project(snapshot)
				require.NoError(t, projectionError)
				require.Len(t, page.Items, limit)
				for _, item := range page.Items {
					require.Equal(t, runID, item.RunID)
					require.NotEmpty(t, item.ClaimID)
					require.NotNil(t, item.ClaimedAt)
					require.Nil(t, item.StartedAt, "领取夹具不是五十次模型执行")
				}
			}
			return err
		})
	}
	require.Equal(t, counts[1], counts[poolhistory.MaxItems], "历史查询不得逐个领取读取完整会话或日志")
	// 原生清理凭证为一次有界批量读取，仍需保持 1／50 项成本相等。
	require.LessOrEqual(t, counts[poolhistory.MaxItems], 7)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}
