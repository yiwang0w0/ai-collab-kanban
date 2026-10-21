package handlers

import (
	"net/http"
	"testing"

	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/service"
	"github.com/stretchr/testify/require"
)

func newPoolCreateFixture(t *testing.T) (poolMoveWireFixture, *poolCreateDispatcher) {
	t.Helper()
	f := newPoolMoveWireFixture(t)
	require.NoError(t, f.tasks.CreateRepository(f.ctx, &models.Repository{ID: "pool-create-repository",
		WorkspaceID: f.task.WorkspaceID, Name: "创建仓库", DefaultBranch: "main"}))
	dispatcher := &poolCreateDispatcher{t: t, fixture: f}
	f.tasks.SetStepEntryDispatcher(dispatcher)
	attachments, err := service.NewAttachmentService(f.tasks, t.TempDir(), nil, f.handler.logger)
	require.NoError(t, err)
	f.service.SetAttachmentService(attachments)
	return f, dispatcher
}

func assertPoolCreateUnpublished(t *testing.T, f poolMoveWireFixture, dispatcher *poolCreateDispatcher) {
	t.Helper()
	require.Zero(t, dispatcher.calls)
	var count int
	require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM task_step_transitions WHERE trigger='pool_release_v1'`))
	require.Zero(t, count)
	require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM runs`))
	require.Zero(t, count)
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolCreateWireRepositoryFailureNeverPublishes(t *testing.T) {
	for _, transport := range []string{"http", "websocket"} {
		t.Run(transport, func(t *testing.T) {
			f, dispatcher := newPoolCreateFixture(t)
			_, err := f.database.Exec(`CREATE TRIGGER reject_pool_create_repository BEFORE INSERT ON task_repositories
				BEGIN SELECT RAISE(ABORT,'required repository rejected'); END`)
			require.NoError(t, err)
			status, _ := f.create(t, transport, f.createPayload())
			require.NotEqual(t, http.StatusOK, status)
			assertPoolCreateUnpublished(t, f, dispatcher)
			var count int
			require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM tasks`))
			require.Equal(t, 1, count, "原生部分创建回滚不能删除原卡或留下新卡")
		})
	}
}

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolCreateWireHTTPRequiredAttachmentFailureNeverPublishes(t *testing.T) {
	f, dispatcher := newPoolCreateFixture(t)
	payload := f.createPayload()
	payload["attachments"] = []map[string]any{{"attachment_id": "missing-create-attachment", "type": "resource",
		"name": "required.txt", "mime_type": "text/plain", "size_bytes": 1}}
	status, body := f.create(t, "http", payload)
	require.Equal(t, http.StatusNotFound, status, string(body))
	assertPoolCreateUnpublished(t, f, dispatcher)
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolCreateWireHTTPReleasedIdentityNeverPublishes(t *testing.T) {
	f, dispatcher := newPoolCreateFixture(t)
	_, err := f.database.Exec(`CREATE TRIGGER release_pool_create_identity AFTER INSERT ON task_repositories
		BEGIN UPDATE tasks SET external_id=NULL, external_id_settled_at=NULL WHERE id=NEW.task_id; END`)
	require.NoError(t, err)
	payload := f.createPayload()
	payload["external_id"] = "pool-identity-released-during-create"
	status, body := f.create(t, "http", payload)
	require.Equal(t, http.StatusOK, status, string(body))
	assertPoolCreateUnpublished(t, f, dispatcher)
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolCreateWireApprovalFailureLeavesIdentityUnsettled(t *testing.T) {
	f, dispatcher := newPoolCreateFixture(t)
	_, err := f.database.Exec(`CREATE TRIGGER reject_pool_create_approval BEFORE INSERT ON task_step_transitions
		WHEN NEW.trigger='pool_release_v1' BEGIN SELECT RAISE(ABORT,'approval storage rejected'); END`)
	require.NoError(t, err)
	payload := f.createPayload()
	payload["external_id"] = "pool-create-unsettled"
	status, _ := f.create(t, "http", payload)
	require.NotEqual(t, http.StatusOK, status)
	assertPoolCreateUnpublished(t, f, dispatcher)
	var unsettled bool
	require.NoError(t, f.database.Get(&unsettled, `SELECT external_id_settled_at IS NULL FROM tasks WHERE external_id=?`, payload["external_id"]))
	require.True(t, unsettled)
}

// @covers AC-TASKS-AGENT-POOL-001.3 AC-TASKS-AGENT-POOL-005.4
func TestPoolCreateWireUnwrittenSettlementRollsBackApproval(t *testing.T) {
	f, dispatcher := newPoolCreateFixture(t)
	_, err := f.database.Exec(`CREATE TRIGGER ignore_pool_create_settlement BEFORE UPDATE OF external_id_settled_at ON tasks
		WHEN NEW.external_id_settled_at IS NOT NULL BEGIN SELECT RAISE(IGNORE); END`)
	require.NoError(t, err)
	payload := f.createPayload()
	payload["external_id"] = "pool-create-settlement-unwritten"
	status, _ := f.create(t, "http", payload)
	require.NotEqual(t, http.StatusOK, status)
	assertPoolCreateUnpublished(t, f, dispatcher)
	var unsettled bool
	require.NoError(t, f.database.Get(&unsettled, `SELECT external_id_settled_at IS NULL FROM tasks WHERE external_id=?`, payload["external_id"]))
	require.True(t, unsettled)
}
