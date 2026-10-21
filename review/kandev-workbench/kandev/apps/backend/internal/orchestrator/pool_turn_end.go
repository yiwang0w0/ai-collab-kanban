package orchestrator

import (
	"context"

	"go.uber.org/zap"

	"github.com/kandev/kandev/internal/agent/runtime/lifecycle"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

type PoolTurnEndRecorder interface {
	ObservePoolTurnEnd(context.Context, runsmodels.PoolExecutionActivity, bool) (*runsmodels.RunEvent, error)
}

func (s *Service) observePoolStreamTurnEnd(ctx context.Context, payload *lifecycle.AgentStreamEventPayload) {
	recorder, supported := s.poolTaskStartGuard.(PoolTurnEndRecorder)
	if !supported {
		return
	}
	activity, failed, trusted := poolStreamTurnEnd(payload)
	if !trusted {
		return
	}
	if _, err := recorder.ObservePoolTurnEnd(ctx, activity, failed); err != nil {
		s.logger.Warn("pool_turn_end_evidence_unconfirmed", zap.String("task_id", activity.TaskID),
			zap.String("session_id", activity.SessionID), zap.String("execution_id", activity.ExecutionID), zap.Error(err))
	}
}

// poolStreamTurnEnd 只消费原生生命周期核验后发布的主回合完成帧，不猜测最新回合。
func poolStreamTurnEnd(payload *lifecycle.AgentStreamEventPayload) (runsmodels.PoolExecutionActivity, bool, bool) {
	if !validPoolStreamOwner(payload) || !validPoolStreamPrompt(payload.Data) || payload.Data.Type != "complete" {
		return runsmodels.PoolExecutionActivity{}, false, false
	}
	failed := false
	if payload.Data.Data != nil {
		data, valid := payload.Data.Data.(map[string]interface{})
		if !valid {
			return runsmodels.PoolExecutionActivity{}, false, false
		}
		if value, exists := data["is_error"]; exists {
			failed, valid = value.(bool)
			if !valid {
				return runsmodels.PoolExecutionActivity{}, false, false
			}
		}
	}
	d := payload.Data
	return runsmodels.PoolExecutionActivity{TaskID: payload.TaskID, AgentProfileID: payload.AgentProfileID,
		SessionID: payload.SessionID, ExecutionID: payload.ExecutionID, TurnID: d.TurnID,
		OperationID: d.OperationID, PromptGeneration: int64(d.PromptGeneration), AgentType: payload.AgentType}, failed, true
}
