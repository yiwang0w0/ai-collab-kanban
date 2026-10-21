package lifecycle

import (
	"context"
	"errors"

	"github.com/kandev/kandev/internal/agent/executor"
	"github.com/kandev/kandev/internal/events"
)

const RuntimeStopSourceStandaloneControl = "standalone_control_v1"

// RuntimeStopConfirmation 只记录宿主确认的运行时停止，不代表数据库占用或 checkout 已释放。
type RuntimeStopConfirmation struct {
	Source                    string `json:"source"`
	RuntimeInstanceID         string `json:"runtime_instance_id"`
	ExecutionActivityReleased bool   `json:"execution_activity_released"`
}

type confirmedInstanceStopper interface {
	StopInstanceConfirmed(context.Context, *ExecutorInstance, bool) (bool, error)
}

func (m *Manager) stopExecutionRuntime(ctx context.Context, executionID string, execution *AgentExecution, reason string, force bool) (*RuntimeStopConfirmation, error) {
	if !execution.workActivityCapture.Load() {
		agentStopFailed := m.stopExecutionAgentctl(ctx, executionID, execution, force)
		return nil, m.stopAgentViaBackend(ctx, executionID, execution, reason, force, agentStopFailed)
	}
	if m.executorRegistry == nil || executionOwnerKind(execution) != ExecutionOwnerTask ||
		execution.RuntimeName != executor.NameStandalone || execution.IsPassthrough {
		return nil, ErrExecutionStopUnconfirmed
	}
	backend, err := m.executorRegistry.GetBackend(execution.RuntimeName)
	if err != nil {
		return nil, errors.Join(ErrExecutionStopUnconfirmed, err)
	}
	stopper, supported := backend.(confirmedInstanceStopper)
	if !supported {
		return nil, ErrExecutionStopUnconfirmed
	}
	instance := &ExecutorInstance{InstanceID: executionID, TaskID: execution.TaskID,
		SessionID: executionInventorySessionID(execution), RuntimeName: execution.RuntimeName,
		StandaloneInstanceID: execution.standaloneInstanceID, StandalonePort: execution.standalonePort,
		Metadata: execution.MetadataSnapshot(), StopReason: reason}
	confirmed, err := stopper.StopInstanceConfirmed(ctx, instance, force)
	if err != nil || !confirmed {
		return nil, errors.Join(ErrExecutionStopUnconfirmed, err)
	}
	return &RuntimeStopConfirmation{Source: RuntimeStopSourceStandaloneControl, RuntimeInstanceID: instance.StandaloneInstanceID}, nil
}

func (m *Manager) detachStoppedAgentctl(execution *AgentExecution, confirmed bool) {
	execution.agentctlLifecycleMu.Lock()
	defer execution.agentctlLifecycleMu.Unlock()
	if confirmed {
		if client := execution.currentAgentCtlClient(); client != nil {
			client.Close()
		}
	}
	execution.detachAgentctlClient()
}

func (m *Manager) executionActivityReleased(executionID string) bool {
	key := executionActivityKey(executionID)
	m.activityMu.Lock()
	defer m.activityMu.Unlock()
	return m.activityCoordinator != nil && m.activityLeases[key] == nil && len(m.activityPending[key]) == 0
}

func (m *Manager) publishStoppedExecution(ctx context.Context, execution *AgentExecution, confirmation *RuntimeStopConfirmation) {
	if confirmation == nil {
		m.eventPublisher.PublishAgentEvent(ctx, events.AgentStopped, execution)
		return
	}
	// 发布前捕获同一回合快照；不持提示锁或活动锁调用订阅者。
	execution.promptLifecycleMu.Lock()
	payload := newAgentEventPayloadWithTurnID(execution, execution.promptTurnID)
	execution.promptLifecycleMu.Unlock()
	confirmation.ExecutionActivityReleased = m.executionActivityReleased(execution.ID)
	payload.RuntimeStopConfirmation = confirmation
	if attemptID := ResumeAttemptIDFromContext(ctx); attemptID != "" {
		payload.AttemptID = attemptID
	}
	_ = m.eventPublisher.publishAgentEventPayload(ctx, events.AgentStopped, payload)
}
