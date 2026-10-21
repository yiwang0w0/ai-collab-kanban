package orchestrator

import (
	"context"
	"encoding/json"

	"go.uber.org/zap"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	"github.com/kandev/kandev/internal/orchestrator/watcher"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

type PoolExecutionStopRecorder interface {
	ObservePoolExecutionStopped(context.Context, runsmodels.PoolExecutionActivity, string, string, bool) (*runsmodels.RunEvent, error)
}

func (s *Service) observePoolExecutionStopped(ctx context.Context, data watcher.AgentEventData) *runsmodels.PoolExecutionIdentity {
	recorder, supported := s.poolTaskStartGuard.(PoolExecutionStopRecorder)
	if !supported || !trustedPoolExecutionStop(data) {
		return nil
	}
	signal := runsmodels.PoolExecutionActivity{TaskID: data.TaskID, AgentProfileID: data.AgentProfileID,
		SessionID: data.SessionID, ExecutionID: data.AgentExecutionID, TurnID: data.TurnID,
		PromptGeneration: int64(data.PromptGeneration), AgentType: data.AgentID}
	proof := data.RuntimeStopConfirmation
	event, err := recorder.ObservePoolExecutionStopped(ctx, signal, proof.Source, proof.RuntimeInstanceID, proof.ExecutionActivityReleased)
	if err != nil {
		s.logger.Warn("pool_execution_stop_evidence_unconfirmed", zap.String("task_id", data.TaskID),
			zap.String("session_id", data.SessionID), zap.String("execution_id", data.AgentExecutionID), zap.Error(err))
		return nil
	}
	if event == nil || !proof.ExecutionActivityReleased {
		return nil
	}
	var receipt runsmodels.PoolExecutionStopReceipt
	if json.Unmarshal([]byte(event.Payload), &receipt) != nil {
		return nil
	}
	expected, valid := signal.StoppedReceipt(runsmodels.PoolExecutionAllocation{
		PoolExecutionIdentity: receipt.PoolExecutionIdentity, AgentType: data.AgentID}, proof.Source, proof.RuntimeInstanceID, true)
	if !valid || expected != receipt || event.RunID != receipt.RunID {
		return nil
	}
	return &receipt.PoolExecutionIdentity
}

func trustedPoolExecutionStop(data watcher.AgentEventData) bool {
	proof := data.RuntimeStopConfirmation
	return proof != nil && proof.Source == lifecycle.RuntimeStopSourceStandaloneControl && proof.RuntimeInstanceID != "" &&
		data.OwnerKind == string(lifecycle.ExecutionOwnerTask) && data.PromptGeneration == 1 && data.TaskID != "" &&
		data.SessionID != "" && data.AgentExecutionID != "" && data.AgentID != "" && data.TurnID != "" && data.AgentProfileID != "" &&
		data.ExecutionProfileID == data.AgentProfileID
}
