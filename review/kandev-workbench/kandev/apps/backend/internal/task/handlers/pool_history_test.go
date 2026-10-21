package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/stretchr/testify/require"
)

type poolHistoryHTTPPage struct {
	TaskID          string                `json:"task_id"`
	SnapshotVersion string                `json:"snapshot_version"`
	Items           []poolHistoryHTTPItem `json:"items"`
	NextCursor      string                `json:"next_cursor"`
}

type poolHistoryHTTPItem struct {
	RunID                 string     `json:"run_id"`
	ClaimID               string     `json:"claim_id"`
	State                 string     `json:"state"`
	PlannedAgentProfileID string     `json:"planned_agent_profile_id"`
	ClaimedAgentProfileID string     `json:"claimed_agent_profile_id"`
	ReleasedAt            *time.Time `json:"released_at"`
	QueuedAt              *time.Time `json:"queued_at"`
	ClaimedAt             *time.Time `json:"claimed_at"`
	StartedAt             *time.Time `json:"started_at"`
}

func poolHistoryHTTPRequest(t *testing.T, f poolMoveWireFixture, ctx context.Context, path string) *httptest.ResponseRecorder {
	t.Helper()
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	})
	f.handler.registerHTTP(router)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	return response
}

type poolHistoryReadState struct {
	Counts    [5]int
	TaskState string
	UpdatedAt time.Time
}

func poolHistorySourceCounts(t *testing.T, f poolMoveWireFixture) poolHistoryReadState {
	t.Helper()
	var state poolHistoryReadState
	require.NoError(t, f.database.QueryRow(`SELECT (SELECT COUNT(*) FROM runs), (SELECT COUNT(*) FROM run_events),
		(SELECT COUNT(*) FROM office_launch_ledger), (SELECT COUNT(*) FROM task_step_transitions),
		(SELECT COUNT(*) FROM tasks), state, updated_at FROM tasks WHERE id=?`, f.task.ID).Scan(
		&state.Counts[0], &state.Counts[1], &state.Counts[2], &state.Counts[3], &state.Counts[4], &state.TaskState, &state.UpdatedAt))
	return state
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolHistoryHTTPKeepsUnboundTaskEmptyAndReadOnly(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	before := poolHistorySourceCounts(t, f)
	response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history?limit=50")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var page poolHistoryHTTPPage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &page))
	require.Equal(t, f.task.ID, page.TaskID)
	require.NotNil(t, page.Items, "无记录不是未返回或数据源失败")
	require.Empty(t, page.Items)
	require.Empty(t, page.NextCursor)
	require.NotEmpty(t, page.SnapshotVersion)
	require.Equal(t, before, poolHistorySourceCounts(t, f), "读取不得补造运行、领取、回执或阶段批准")
}

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-002.4
func TestPoolHistoryHTTPSeparatesCommittedReleaseFromQueuedRunWithoutInventingClaim(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	status, body := f.move(t, "http", f.payload())
	require.Equal(t, http.StatusOK, status, string(body))
	path := "/api/v1/tasks/" + f.task.ID + "/pool-history"
	released := poolHistoryHTTPRequest(t, f, f.ctx, path)
	require.Equal(t, http.StatusOK, released.Code, released.Body.String())
	var page poolHistoryHTTPPage
	require.NoError(t, json.Unmarshal(released.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	require.Equal(t, "released", page.Items[0].State)
	require.NotNil(t, page.Items[0].ReleasedAt)
	require.Empty(t, page.Items[0].RunID)
	require.Nil(t, page.Items[0].QueuedAt)
	var entryID int64
	require.NoError(t, f.database.QueryRow(`SELECT MAX(id) FROM task_step_transitions WHERE task_id=?`, f.task.ID).Scan(&entryID))
	_, err := f.service.PublishPoolRelease(f.ctx, f.task.ID, f.step.ID, strconv.FormatInt(entryID, 10))
	require.NoError(t, err)
	var runID string
	var requested time.Time
	require.NoError(t, f.database.QueryRow(`SELECT id,requested_at FROM runs`).Scan(&runID, &requested))
	_, err = f.database.Exec(`UPDATE runs SET assembled_prompt=? WHERE id=?`, "PRIVATE-PROMPT-NOT-FOR-HISTORY", runID)
	require.NoError(t, err)
	before := poolHistorySourceCounts(t, f)
	queued := poolHistoryHTTPRequest(t, f, f.ctx, path)
	require.Equal(t, http.StatusOK, queued.Code, queued.Body.String())
	require.NoError(t, json.Unmarshal(queued.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	item := page.Items[0]
	require.Equal(t, runID, item.RunID)
	require.Equal(t, "queued", item.State)
	require.Equal(t, f.step.AgentProfileID, item.PlannedAgentProfileID)
	require.Empty(t, item.ClaimID)
	require.Empty(t, item.ClaimedAgentProfileID, "阶段指定的 Profile 不能冒充领取者")
	require.NotNil(t, item.QueuedAt)
	require.True(t, item.QueuedAt.Equal(requested))
	require.Nil(t, item.ClaimedAt)
	require.Nil(t, item.StartedAt)
	require.NotContains(t, queued.Body.String(), "PRIVATE-PROMPT-NOT-FOR-HISTORY")
	require.NotContains(t, queued.Body.String(), "assembled_prompt")
	replayed := poolHistoryHTTPRequest(t, f, f.ctx, path)
	require.Equal(t, queued.Body.String(), replayed.Body.String(), "读取不改变语义快照版本或补造时间")
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

func TestPoolHistoryHTTPRejectsUnboundedAndMalformedPaging(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	for _, query := range []string{"limit=51", "limit=-1", "limit=not-a-number", "cursor=not-a-valid-cursor"} {
		t.Run(query, func(t *testing.T) {
			before := poolHistorySourceCounts(t, f)
			response := poolHistoryHTTPRequest(t, f, f.ctx, "/api/v1/tasks/"+f.task.ID+"/pool-history?"+query)
			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Equal(t, before, poolHistorySourceCounts(t, f))
		})
	}
}

func TestPoolHistoryHTTPHidesForeignTaskExactlyLikeMissingTask(t *testing.T) {
	f := newPoolMoveWireFixture(t)
	foreign := authn.WithIdentity(context.Background(), authn.Identity{UserID: "pool-history-other", SessionID: "other-browser"})
	before := poolHistorySourceCounts(t, f)
	denied := poolHistoryHTTPRequest(t, f, foreign, "/api/v1/tasks/"+f.task.ID+"/pool-history")
	missing := poolHistoryHTTPRequest(t, f, foreign, "/api/v1/tasks/missing-pool-task/pool-history")
	require.Equal(t, http.StatusNotFound, denied.Code, denied.Body.String())
	require.Equal(t, missing.Code, denied.Code)
	require.Equal(t, missing.Body.String(), denied.Body.String())
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}
