package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jmoiron/sqlx"
	settingsmodels "github.com/kandev/kandev/internal/agent/settings/models"
	settingsstore "github.com/kandev/kandev/internal/agent/settings/store"
	"github.com/kandev/kandev/internal/auth/authn"
	officesqlite "github.com/kandev/kandev/internal/office/repository/sqlite"
	"github.com/kandev/kandev/internal/orchestrator"
	runssqlite "github.com/kandev/kandev/internal/runs/repository/sqlite"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/task/models"
	tasksqlite "github.com/kandev/kandev/internal/task/repository/sqlite"
	"github.com/kandev/kandev/internal/task/service"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	workflowrepo "github.com/kandev/kandev/internal/workflow/repository"
	workflowservice "github.com/kandev/kandev/internal/workflow/service"
	v1 "github.com/kandev/kandev/pkg/api/v1"
	ws "github.com/kandev/kandev/pkg/websocket"
	_ "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/require"
)

type poolWireCompatibility struct{}

func (poolWireCompatibility) ValidateAgentProfileForExecutor(context.Context, *settingsmodels.AgentProfile, *models.Executor, *models.ExecutorProfile) error {
	return nil
}

type poolMoveWireFixture struct {
	handler   *TaskHandlers
	service   *service.Service
	tasks     *tasksqlite.Repository
	runs      *runssqlite.Repository
	database  *sqlx.DB
	task      *models.Task
	step      *wfmodels.WorkflowStep
	workflows *workflowrepo.Repository
	ctx       context.Context
}

func newPoolMoveWireFixture(t *testing.T) poolMoveWireFixture {
	t.Helper()
	log := newTestLogger(t)
	database, err := sqlx.Open("sqlite3", filepath.Join(t.TempDir(), "pool-wire.db")+"?_foreign_keys=on&_busy_timeout=5000")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Close()) })
	database.SetMaxOpenConns(1)
	profiles, _, err := settingsstore.Provide(database, database, nil)
	require.NoError(t, err)
	tasks, err := tasksqlite.NewWithDB(database, database, nil)
	require.NoError(t, err)
	workflows, err := workflowrepo.NewWithDB(database, database, nil)
	require.NoError(t, err)
	office, err := officesqlite.NewWithDB(database, database, nil)
	require.NoError(t, err)
	svc := service.NewService(service.Repos{Tasks: tasks, Workspaces: tasks, Workflows: tasks,
		TaskRepos: tasks, Sessions: tasks, Turns: tasks, Messages: tasks, Attachments: tasks, Executors: tasks, RepoEntities: tasks,
		AgentProfiles: profiles, AgentProfileExecutorValidator: poolWireCompatibility{}}, nil, log, service.RepositoryDiscoveryConfig{})
	svc.SetWorkflowStepGetter(workflowservice.NewService(workflows, log))
	svc.SetBlockerRepository(office)
	admission := &orchestrator.Service{}
	queue := runsservice.New(office.RunsRepository(), nil, log, nil)
	queue.SetPoolReleaseSource(tasks)
	queue.SetPoolEnqueueAdmission(admission)
	svc.SetPoolRunQueue(queue)
	svc.SetPoolReleaseAdmission(admission)
	ctx := authn.WithIdentity(context.Background(), authn.Identity{UserID: "pool-wire-human", SessionID: "pool-wire-browser", Role: authn.RoleAdmin})
	f := poolMoveWireFixture{handler: &TaskHandlers{service: svc, logger: log}, service: svc, tasks: tasks, workflows: workflows,
		runs: office.RunsRepository(), database: database, ctx: ctx}
	f.seed(t, workflows)
	return f
}

func (f *poolMoveWireFixture) seed(t *testing.T, workflows *workflowrepo.Repository) {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, f.tasks.CreateWorkspace(ctx, &models.Workspace{ID: "pool-wire-ws", Name: "入口验证", OwnerID: "pool-wire-human"}))
	require.NoError(t, f.tasks.CreateWorkflow(ctx, &models.Workflow{ID: "pool-wire-workflow", WorkspaceID: "pool-wire-ws", Name: "原生流程"}))
	backlog := &wfmodels.WorkflowStep{ID: "pool-wire-backlog", WorkflowID: "pool-wire-workflow", Name: "待办", AllowManualMove: true}
	f.step = &wfmodels.WorkflowStep{ID: "pool-wire-step", WorkflowID: backlog.WorkflowID, Name: "实施", Position: 1,
		AllowManualMove: true, AgentProfileID: "pool-wire-profile", Events: wfmodels.StepEvents{OnEnter: []wfmodels.OnEnterAction{
			{Type: wfmodels.OnEnterQueueRun, Config: map[string]any{"pool_version": 1}},
		}}}
	require.NoError(t, workflows.CreateStep(ctx, backlog))
	require.NoError(t, workflows.CreateStep(ctx, f.step))
	now := time.Now().UTC()
	_, err := f.database.Exec(`INSERT INTO agents (id,name,created_at,updated_at) VALUES ('pool-wire-agent','claude-acp',?,?)`, now, now)
	require.NoError(t, err)
	_, err = f.database.Exec(`INSERT INTO agent_profiles (id,agent_id,name,agent_display_name,enabled,created_at,updated_at)
		VALUES ('pool-wire-profile','pool-wire-agent','入口 CLI','CLI',1,?,?)`, now, now)
	require.NoError(t, err)
	f.task = &models.Task{ID: "pool-wire-task", WorkspaceID: "pool-wire-ws", WorkflowID: backlog.WorkflowID, WorkflowStepID: backlog.ID,
		Title: "原生主卡", Priority: "medium", State: v1.TaskStateTODO, Metadata: map[string]any{models.MetaKeyExecutorID: models.ExecutorIDWorktree}}
	require.NoError(t, f.tasks.CreateTask(ctx, f.task))
}

func (f poolMoveWireFixture) payload() map[string]any {
	return map[string]any{"id": f.task.ID, "workflow_id": f.task.WorkflowID, "workflow_step_id": f.step.ID, "position": 0,
		"pool_release": map[string]any{"confirm_cli_quota": true, "expected_resource_version": f.task.UpdatedAt.UTC().Format(time.RFC3339Nano),
			"expected_step_version": f.step.UpdatedAt.UTC().Format(time.RFC3339Nano)}}
}

func (f poolMoveWireFixture) move(t *testing.T, transport string, payload map[string]any) (int, []byte) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	require.NoError(t, err)
	if transport == "http" {
		response := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(response)
		ctx.Params = gin.Params{{Key: "id", Value: f.task.ID}}
		ctx.Request = httptest.NewRequest(http.MethodPost, "/api/v1/tasks/"+f.task.ID+"/move", strings.NewReader(string(encoded))).WithContext(f.ctx)
		ctx.Request.Header.Set("Content-Type", "application/json")
		f.handler.httpMoveTask(ctx)
		return response.Code, response.Body.Bytes()
	}
	response, err := f.handler.wsMoveTask(f.ctx, &ws.Message{ID: "pool-wire-move", Action: "task.move", Type: ws.MessageTypeRequest, Payload: encoded})
	require.NoError(t, err)
	require.NotNil(t, response)
	if response.Type == ws.MessageTypeResponse {
		return http.StatusOK, response.Payload
	}
	var wireError ws.ErrorPayload
	require.NoError(t, json.Unmarshal(response.Payload, &wireError))
	status := http.StatusInternalServerError
	switch wireError.Code {
	case ws.ErrorCodeBadRequest, ws.ErrorCodeValidation:
		status = http.StatusBadRequest
	case ws.ErrorCodeConflict:
		status = http.StatusConflict
	case ws.ErrorCodeUnavailable:
		status = http.StatusServiceUnavailable
	case ws.ErrorCodeNotFound:
		status = http.StatusNotFound
	case ws.ErrorCodeForbidden:
		status = http.StatusForbidden
	}
	return status, response.Payload
}
