package plugins

import (
	"context"
	taskmodels "github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/pkg/pluginsdk"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"testing"
)

type completionReadData struct{ *fakeTaskDataSource }

func (d completionReadData) GetTaskCompletionGate(_ context.Context, id string) (*taskmodels.TaskCompletionGateSnapshot, error) {
	return &taskmodels.TaskCompletionGateSnapshot{TaskID: id, WorkspaceID: "workspace-one", Revision: 8, Blocked: true}, nil
}

func TestCompletionGateReadIsWorkspaceAuthorized(t *testing.T) {
	data := completionReadData{&fakeTaskDataSource{
		tasksByID:        map[string]*taskmodels.Task{"task-one": {ID: "task-one", WorkspaceID: "workspace-one"}, "task-foreign": {ID: "task-foreign", WorkspaceID: "workspace-two"}},
		workspaces:       []*taskmodels.Workspace{{ID: "workspace-one"}},
		tasksByWorkspace: map[string][]*taskmodels.Task{"workspace-one": {{ID: "task-one", WorkspaceID: "workspace-one"}}, "workspace-two": {{ID: "task-foreign", WorkspaceID: "workspace-two"}}},
	}}
	host := newExactTaskReadHost(t, data)
	reader, ok := pluginsdk.HostTaskCompletionGateReader(dialPluginHostOverWire(t, host))
	if !ok {
		t.Fatal("缺少只读门禁接口")
	}
	query := pluginsdk.TaskCompletionGateRead{RequestID: "gate-read", WorkspaceID: "workspace-one", TaskID: "task-one"}
	gate, err := reader.ReadTaskCompletionGate(context.Background(), query)
	if err != nil || gate.Revision != 8 {
		t.Fatalf("门禁未读回: %+v %v", gate, err)
	}
	query.TaskID = "task-foreign"
	if _, err := reader.ReadTaskCompletionGate(context.Background(), query); status.Code(err) != codes.NotFound {
		t.Fatalf("跨工作区泄露: %v", err)
	}
	denied := newExactReadHost(t, data, []string{"tasks"}, nil)
	query.TaskID = "task-one"
	if _, err := denied.ReadTaskCompletionGate(context.Background(), query); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("无授权可读: %v", err)
	}
}
