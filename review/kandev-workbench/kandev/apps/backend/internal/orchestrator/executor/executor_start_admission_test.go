package executor

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

// @covers AC-TASKS-AGENT-POOL-002.1 AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionStartAdmissionVetoesProcessOnBothNativeLaunchPaths(t *testing.T) {
	for _, existing := range []bool{false, true} {
		for _, deny := range []bool{false, true} {
			t.Run(map[bool]string{false: "new", true: "existing"}[existing]+"/"+map[bool]string{false: "allow", true: "deny"}[deny], func(t *testing.T) {
				assertExecutionStartAdmission(t, existing, deny)
			})
		}
	}
}

func assertExecutionStartAdmission(t *testing.T, existing, deny bool) {
	t.Helper()
	ctx := context.Background()
	repo := newMockRepository()
	task := &v1.Task{ID: "admission-task", WorkspaceID: "admission-workspace"}
	session := &models.TaskSession{ID: "admission-session", TaskID: task.ID,
		AgentProfileID: "fixed-profile", State: models.TaskSessionStateCreated, Metadata: map[string]any{}}
	repo.tasks[task.ID] = &models.Task{ID: task.ID, WorkspaceID: task.WorkspaceID}
	repo.sessions[session.ID] = cloneMockTaskSession(session)
	if existing {
		repo.executorsRunning[session.ID] = &models.ExecutorRunning{ID: "existing-runtime", TaskID: task.ID,
			SessionID: session.ID, AgentExecutionID: "allocated-execution", Status: models.ExecutorRunningStatusPrepared}
	}
	starts := make(chan string, 1)
	manager := &mockAgentManager{
		launchAgentFunc: func(context.Context, *LaunchAgentRequest) (*LaunchAgentResponse, error) {
			return &LaunchAgentResponse{AgentExecutionID: "allocated-execution", ContainerID: "workspace"}, nil
		},
		getExecutionIDForSessionFunc: func(context.Context, string) (string, error) { return "allocated-execution", nil },
		startAgentProcessFunc:        func(_ context.Context, id string) error { starts <- id; return nil },
	}
	exec := newTestExecutor(t, manager, repo)
	denied := errors.New("执行关联持久化失败")
	var admissions, legacy atomic.Int32
	opts := LaunchOptions{AgentProfileID: session.AgentProfileID, Prompt: "只走模拟执行", StartAgent: true,
		OnExecutionAdmitted: func(string) { legacy.Add(1) }}
	opts.BeforeExecutionStart = func(id string) error {
		admissions.Add(1)
		if id != "allocated-execution" || legacy.Load() != 0 {
			t.Error("必须先准入实际执行，再通知既有回调或启动代理")
		}
		if deny {
			return denied
		}
		return nil
	}
	execution, err := exec.LaunchPreparedSession(ctx, task, session.ID, opts)
	if admissions.Load() != 1 {
		t.Fatalf("原生启动必须核验一次实际分配身份: calls=%d err=%v", admissions.Load(), err)
	}
	assertExecutionStartAdmissionOutcome(t, execution, err, denied, deny, legacy.Load(), starts)
}

func assertExecutionStartAdmissionOutcome(t *testing.T, execution *TaskExecution, err, denied error, deny bool, legacy int32, starts <-chan string) {
	t.Helper()
	if deny {
		if !errors.Is(err, denied) || execution != nil || legacy != 0 {
			t.Fatalf("写入拒绝不能继续旧回调或返回已启动: execution=%+v err=%v legacy=%d", execution, err, legacy)
		}
		select {
		case id := <-starts:
			t.Fatalf("被拒绝的执行不得启动进程: %s", id)
		default:
		}
		return
	}
	if err != nil || execution == nil || legacy != 1 {
		t.Fatalf("同夹具放行应保留原生启动及旧通知: execution=%+v err=%v legacy=%d", execution, err, legacy)
	}
	select {
	case <-starts:
	case <-time.After(3 * time.Second):
		t.Fatal("正对照没有实际抵达模拟进程启动")
	}
}
