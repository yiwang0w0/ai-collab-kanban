package plugins

import (
	"context"

	taskmodels "github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/pkg/pluginsdk"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (h *pluginHost) ReadTaskCompletionGate(ctx context.Context, query pluginsdk.TaskCompletionGateRead) (*pluginsdk.TaskCompletionGate, error) {
	_, unlock, err := h.exactReadAdmission(ctx, query.RequestID, query.WorkspaceID, "ReadTaskCompletionGate", "host.v2.read:tasks", map[string]string{"task_id": query.TaskID})
	if err != nil {
		return nil, err
	}
	defer unlock()
	reader, ok := h.taskData.(interface {
		GetTaskCompletionGate(context.Context, string) (*taskmodels.TaskCompletionGateSnapshot, error)
	})
	if !ok {
		return nil, status.Error(codes.Unimplemented, "任务门禁读取服务不可用")
	}
	task, err := h.taskData.GetTask(ctx, query.TaskID)
	if err != nil || task == nil || task.WorkspaceID != query.WorkspaceID {
		return nil, status.Error(codes.NotFound, "任务不存在")
	}
	gate, err := reader.GetTaskCompletionGate(ctx, query.TaskID)
	if err != nil {
		return nil, err
	}
	if gate == nil || gate.TaskID != query.TaskID || gate.WorkspaceID != query.WorkspaceID {
		return nil, status.Error(codes.Unavailable, "任务门禁范围不一致")
	}
	return taskCompletionGateToSDK(gate), nil
}
