package handlers

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/poolhistory"
	"github.com/kandev/kandev/internal/task/poolview"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	v1 "github.com/kandev/kandev/pkg/api/v1"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-003.4
func TestPoolProjectionNativeQueryBudgetStaysFlatFromOneToFiftyCards(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	ids := seedPoolProjectionBudgetCards(t, f)
	repo, counter := newPoolProjectionCountingReader(t, f)
	before := poolHistorySourceCounts(t, f)
	require.Equal(t, poolhistory.MaxItems, before.Counts[0])
	require.Equal(t, 1, before.Counts[2], "夹具只有一次真实领取，其他运行仅排队，不伪造并发执行")
	oneQueries := measurePoolProjectionBudget(t, counter, "单卡列表", func(ctx context.Context) error {
		page, err := repo.ReadPoolProjectionSnapshot(ctx, f.task.WorkspaceID, poolview.Query{Limit: 1})
		if err == nil {
			require.Len(t, page.Cards, 1)
		}
		return err
	})
	var stablePage *poolview.Page
	fiftyQueries := measurePoolProjectionBudget(t, counter, "五十卡列表", func(ctx context.Context) error {
		page, err := repo.ReadPoolProjectionSnapshot(ctx, f.task.WorkspaceID, poolview.Query{Limit: poolhistory.MaxItems})
		if err == nil {
			require.Len(t, page.Cards, poolhistory.MaxItems)
			stablePage, err = poolview.Project(page)
		}
		return err
	})
	require.Equal(t, oneQueries, fiftyQueries, "工作区读取不得为每张卡追加一次会话或历史读取")
	// A 的清理凭证增加一次按整页键集合读取，不随卡片数量增加。
	require.LessOrEqual(t, fiftyQueries, 9)
	singleSummary := measurePoolSummaryBudget(t, repo, counter, f.task.WorkspaceID, ids[:1])
	fiftySummary := measurePoolSummaryBudget(t, repo, counter, f.task.WorkspaceID, ids)
	require.Equal(t, singleSummary, fiftySummary, "摘要重建必须使用真正的批量来源")
	require.LessOrEqual(t, fiftySummary, 7)
	seedPoolProjectionBudgetLogs(t, f, claim.ID)
	withLogs := poolHistorySourceCounts(t, f)
	require.Equal(t, before.Counts[1]+10000, withLogs.Counts[1])
	logQueries := measurePoolProjectionBudget(t, counter, "含一万条非池日志的五十卡列表", func(ctx context.Context) error {
		snapshot, err := repo.ReadPoolProjectionSnapshot(ctx, f.task.WorkspaceID, poolview.Query{Limit: poolhistory.MaxItems})
		if err == nil {
			page, projectionError := poolview.Project(snapshot)
			require.NoError(t, projectionError)
			require.Len(t, page.Items, poolhistory.MaxItems)
			require.NotNil(t, page.Items[0].PoolExecution)
			require.Equal(t, "claimed", page.Items[0].PoolExecution.State)
			require.Equal(t, claim.ClaimID, page.Items[0].PoolExecution.ClaimID)
			require.Empty(t, snapshot.Histories[f.task.ID].Events, "非池日志不得进入有界池投影")
			require.Equal(t, stablePage, page, "普通日志不改变池快照的正文、身份或语义版本")
		}
		return err
	})
	require.Equal(t, fiftyQueries, logQueries)
	require.Equal(t, withLogs, poolHistorySourceCounts(t, f))
	require.Equal(t, before.Counts[0], withLogs.Counts[0], "日志压测没有创建额外运行或模拟执行")
}

func measurePoolProjectionBudget(t *testing.T, counter *poolProjectionQueryCounter, label string, read func(context.Context) error) int {
	t.Helper()
	counter.reset()
	// 各项是独立的三秒查询预算，前一项不能挤占后一项的期限。
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	started := time.Now()
	require.NoError(t, read(ctx))
	queries := counter.count()
	require.Positive(t, queries, "必须实际经过驱动，空计数不证明没有查询")
	t.Logf("%s: SQL=%d，耗时=%s", label, queries, time.Since(started))
	return queries
}

func measurePoolSummaryBudget(t *testing.T, repo *tasksqlite.Repository, counter *poolProjectionQueryCounter, workspaceID string, ids []string) int {
	t.Helper()
	return measurePoolProjectionBudget(t, counter, fmt.Sprintf("%d 卡摘要", len(ids)), func(ctx context.Context) error {
		snapshot, err := repo.ReadPoolSummarySnapshot(ctx, workspaceID, ids)
		if err == nil {
			require.Len(t, snapshot.Cards, len(ids))
		}
		return err
	})
}

func seedPoolProjectionBudgetCards(t *testing.T, f poolMoveWireFixture) []string {
	t.Helper()
	ids := []string{f.task.ID}
	for i := 1; i < poolhistory.MaxItems; i++ {
		task := &models.Task{ID: fmt.Sprintf("zz-pool-query-%03d", i), WorkspaceID: f.task.WorkspaceID,
			WorkflowID: f.task.WorkflowID, WorkflowStepID: "pool-wire-backlog", Title: "查询预算主卡",
			Priority: "medium", State: v1.TaskStateTODO, Metadata: map[string]any{models.MetaKeyExecutorID: models.ExecutorIDWorktree}}
		require.NoError(t, f.tasks.CreateTask(f.ctx, task))
		other := f
		other.task = task
		status, body := other.move(t, "http", other.payload())
		require.Equal(t, http.StatusOK, status, string(body))
		var entryID int64
		require.NoError(t, f.database.Get(&entryID, `SELECT MAX(id) FROM task_step_transitions WHERE task_id=?`, task.ID))
		_, err := f.service.PublishPoolRelease(f.ctx, task.ID, f.step.ID, strconv.FormatInt(entryID, 10))
		require.NoError(t, err)
		ids = append(ids, task.ID)
	}
	return ids
}

func seedPoolProjectionBudgetLogs(t *testing.T, f poolMoveWireFixture, runID string) {
	t.Helper()
	// 这是没有池身份的普通日志夹具，不冒充真实模型活动或一万次执行。
	_, err := f.database.Exec(`WITH RECURSIVE number(n) AS (
		SELECT 0 UNION ALL SELECT n+1 FROM number WHERE n<9999
	) INSERT INTO run_events(run_id,seq,event_type,payload,created_at)
	SELECT ?,n,'agent.output',?,? FROM number`, runID, strings.Repeat("PRIVATE-NONPOOL-LOG-", 24), time.Now().UTC())
	require.NoError(t, err)
}
