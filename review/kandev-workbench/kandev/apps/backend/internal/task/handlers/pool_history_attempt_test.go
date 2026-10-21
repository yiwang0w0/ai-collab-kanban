package handlers

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"
)

func queuedPoolHistoryFixture(t *testing.T) poolMoveWireFixture {
	t.Helper()
	f := newPoolMoveWireFixture(t)
	status, body := f.move(t, "http", f.payload())
	require.Equal(t, http.StatusOK, status, string(body))
	var entryID int64
	require.NoError(t, f.database.QueryRow(`SELECT MAX(id) FROM task_step_transitions WHERE task_id=?`, f.task.ID).Scan(&entryID))
	_, err := f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, strconv.FormatInt(entryID, 10))
	require.NoError(t, err)
	return f
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolHistoryHTTPPagesEveryImmutableClaimOfOneRelease(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	first, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, first)
	// 仅构造尚未调用执行器的历史夹具，不把直接改状态当作生产恢复能力。
	_, err = f.database.Exec(`UPDATE runs SET status='queued',claimed_at=NULL WHERE id=?`, first.ID)
	require.NoError(t, err)
	second, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, second)
	require.Equal(t, first.ID, second.ID)
	require.NotEqual(t, first.ClaimID, second.ClaimID)
	before := poolHistorySourceCounts(t, f)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var all poolHistoryHTTPPage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &all))
	require.Len(t, all.Items, 2, "同一 run 的两次原生领取必须各自保留，不合并或覆盖")
	ids := []string{all.Items[0].ClaimID, all.Items[1].ClaimID}
	require.ElementsMatch(t, []string{first.ClaimID, second.ClaimID}, ids)
	var seen []string
	cursor, terminal := "", false
	for pageNumber := 0; pageNumber < 3; pageNumber++ {
		page := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history?limit=1&cursor="+url.QueryEscape(cursor))
		require.Equal(t, http.StatusOK, page.Code, page.Body.String())
		var body poolHistoryHTTPPage
		require.NoError(t, json.Unmarshal(page.Body.Bytes(), &body))
		require.Len(t, body.Items, 1)
		seen = append(seen, body.Items[0].ClaimID)
		if body.NextCursor == "" {
			terminal = true
			break
		}
		require.NotEqual(t, cursor, body.NextCursor)
		cursor = body.NextCursor
	}
	require.True(t, terminal)
	require.ElementsMatch(t, ids, seen, "分页必须遍历同一进入记录内的所有领取，不能跳到下个阶段")
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.2
func TestPoolHistoryHTTPUsesActualImmutableClaimWithoutInventingWork(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	require.NotEmpty(t, claim.ClaimID)
	require.NotNil(t, claim.ClaimedAt)
	before := poolHistorySourceCounts(t, f)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var page poolHistoryHTTPPage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	item := page.Items[0]
	require.Equal(t, "claimed", item.State)
	require.Equal(t, claim.ID, item.RunID)
	require.Equal(t, claim.ClaimID, item.ClaimID)
	require.Equal(t, claim.AgentProfileID, item.ClaimedAgentProfileID)
	require.NotNil(t, item.ClaimedAt)
	require.True(t, item.ClaimedAt.Equal(*claim.ClaimedAt))
	require.Nil(t, item.StartedAt, "领取不是开工证明")
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}
