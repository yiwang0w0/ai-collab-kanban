package orchestrator

import (
	"context"
	"encoding/json"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

type PoolExecutionBinder interface {
	BindPoolExecution(context.Context, runsmodels.PoolClaimStart, runsmodels.PoolExecutionIdentity) (*runsmodels.RunEvent, error)
}

type PoolActivityRecorder interface {
	ObservePoolActivity(context.Context, runsmodels.PoolExecutionActivity) (*runsmodels.RunEvent, error)
}

type poolExecutionRuntime interface {
	PoolExecutionBinder
	PoolActivityRecorder
}

type poolWorkActivityCapture interface {
	EnableWorkActivity(context.Context, string, string) error
}

// poolExecutionStartAdmission 捕获本次私有领取和原生分配，不在返回后查询最近会话。
func (s *Service) poolExecutionStartAdmission(ctx context.Context, claim *runsmodels.PoolClaimStart, sessionID, turnID, executionProfileID string) func(string) error {
	if claim == nil {
		return nil
	}
	request := *claim
	identity := runsmodels.PoolExecutionIdentity{RunID: request.RunID, ClaimID: request.ClaimID,
		TaskID: request.Release.TaskID, AgentProfileID: request.Release.AgentProfileID, ExecutionProfileID: executionProfileID,
		SessionID: sessionID, TurnID: turnID, PromptGeneration: 1}
	return func(executionID string) error {
		binder, ok := s.poolTaskStartGuard.(poolExecutionRuntime)
		if !ok {
			return runsmodels.ErrPoolAdmissionUnavailable
		}
		identity.ExecutionID = executionID
		event, err := binder.BindPoolExecution(ctx, request, identity)
		if err != nil {
			return err
		}
		var allocated runsmodels.PoolExecutionAllocation
		if event == nil || event.RunID != request.RunID || event.EventType != runsmodels.PoolExecutionAllocated ||
			json.Unmarshal([]byte(event.Payload), &allocated) != nil || allocated.PoolExecutionIdentity != identity || allocated.AgentType == "" {
			return runsmodels.ErrPoolClaimStartConflict
		}
		capture, ok := s.agentManager.(poolWorkActivityCapture)
		if !ok {
			return runsmodels.ErrPoolAdmissionUnavailable
		}
		return capture.EnableWorkActivity(ctx, executionID, turnID)
	}
}
