package backendapp

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	settingsdto "github.com/kandev/kandev/internal/agent/settings/dto"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolHostNativeMock(t *testing.T) {
	f := newPoolBinaryHost(t)
	f.request(t, http.MethodPost, "/api/v1/auth/setup", map[string]any{
		"email": "pool-host@example.invalid", "password": uuid.NewString(), "display_name": "池宿主夹具",
	}, nil)
	var identity struct {
		Mode string `json:"mode"`
	}
	f.request(t, http.MethodGet, "/api/v1/auth/me", nil, &identity)
	require.Equal(t, "enabled", identity.Mode)
	var workspace, workflow struct {
		ID string `json:"id"`
	}
	f.request(t, http.MethodPost, "/api/v1/workspaces", map[string]any{"name": "池宿主", "default_executor_id": models.ExecutorIDWorktree}, &workspace)
	f.request(t, http.MethodPost, "/api/v1/workflows", map[string]any{"workspace_id": workspace.ID, "name": "池流程"}, &workflow)
	var agents settingsdto.ListAgentsResponse
	f.request(t, http.MethodGet, "/api/v1/agents", nil, &agents)
	agentID := ""
	for _, agent := range agents.Agents {
		if agent.Name == "claude-acp" {
			require.Empty(t, agentID)
			agentID = agent.ID
		}
	}
	require.NotEmpty(t, agentID)
	var profile settingsdto.AgentProfileDTO
	f.request(t, http.MethodPost, fmt.Sprintf("/api/v1/agents/%s/profiles", agentID), map[string]any{
		"name": "池 CLI 模拟", "model": "mock-fast", "auto_fallback": false, "auto_approve": true, "cli_passthrough": false,
	}, &profile)
	require.NotEmpty(t, profile.ID)
	var repository struct {
		ID string `json:"id"`
	}
	f.request(t, http.MethodPost, fmt.Sprintf("/api/v1/workspaces/%s/repositories", workspace.ID), map[string]any{
		"name": "pool-repo", "source_type": "local", "local_path": filepath.Join(f.root, "r"), "default_branch": "main", "pull_before_worktree": false,
	}, &repository)
	var step struct {
		ID        string `json:"id"`
		UpdatedAt string `json:"updated_at"`
	}
	f.request(t, http.MethodPost, "/api/v1/workflow/steps", map[string]any{"workflow_id": workflow.ID,
		"name": "执行", "position": 0, "agent_profile_id": profile.ID, "allow_manual_move": true,
		"events": map[string]any{"on_enter": []map[string]any{{"type": "queue_run", "config": map[string]any{"pool_version": 1}}}},
	}, &step)
	require.NotEmpty(t, step.UpdatedAt)
	var task struct {
		ID string `json:"id"`
	}
	taskRequest := map[string]any{
		"workspace_id": workspace.ID, "workflow_id": workflow.ID, "workflow_step_id": step.ID,
		"external_id": "pool-host-one",
		"title":       "PoolOne", "description": `e2e:message("池模拟工作")`, "executor_id": models.ExecutorIDWorktree,
		"repositories": []map[string]any{{"repository_id": repository.ID, "base_branch": "main"}},
		"pool_release": map[string]any{"confirm_cli_quota": true, "expected_resource_version": "", "expected_step_version": step.UpdatedAt},
	}
	f.request(t, http.MethodPost, "/api/v1/tasks", taskRequest, &task)
	require.NotEmpty(t, task.ID)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := f.stopTask(ctx, task.ID); err != nil {
			t.Errorf("私有池任务清理未确认：%v", err)
		}
	})
	f.assertNativePoolEvidence(t, task.ID)
	f.assertPoolRestartUnchanged(t, task.ID, taskRequest)
}
