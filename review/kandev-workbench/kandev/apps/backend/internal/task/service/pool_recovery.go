package service

import (
	"context"
	"strings"

	"github.com/kandev/kandev/internal/authz"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

type poolRunRecoverer interface {
	RecoverPoolRun(context.Context, string, runsmodels.PoolRecoveryCommand) (*runsmodels.RunEvent, error)
}

type poolRunRecoveryReader interface {
	GetPoolRecoveryContext(context.Context, string, string) (*runsmodels.PoolRecoveryContext, error)
	GetPoolRecoveryOperation(context.Context, string, string, string) (*runsmodels.RunEvent, error)
}

func (s *Service) GetPoolRecoveryContext(ctx context.Context, taskID, runID string) (*runsmodels.PoolRecoveryContext, error) {
	decision, err := s.poolRecoveryDecision(ctx, taskID)
	if err != nil {
		return nil, err
	}
	reader, supported := s.poolRunQueue.(poolRunRecoveryReader)
	if !supported {
		return nil, runsmodels.ErrPoolAdmissionUnavailable
	}
	result, err := reader.GetPoolRecoveryContext(ctx, taskID, runID)
	if err != nil {
		return nil, err
	}
	if result == nil || result.TaskID != taskID || result.RunID != runID {
		return nil, runsmodels.ErrPoolAdmissionUnavailable
	}
	result.Actions.Withdraw = result.Actions.Withdraw && decision.Has(authz.ScopeTaskWrite)
	result.Actions.Stop = result.Actions.Stop && decision.Has(authz.ScopeTaskWrite) && decision.Has(authz.ScopeSessionControl)
	result.Actions.Retry = result.Actions.Retry && decision.Has(authz.ScopeTaskWrite) && decision.Has(authz.ScopeSessionExec)
	return result, nil
}

func (s *Service) GetPoolRecoveryOperation(ctx context.Context, taskID, runID, operationID string) (*runsmodels.RunEvent, error) {
	if _, err := s.poolRecoveryDecision(ctx, taskID); err != nil {
		return nil, err
	}
	reader, supported := s.poolRunQueue.(poolRunRecoveryReader)
	if !supported {
		return nil, runsmodels.ErrPoolAdmissionUnavailable
	}
	return reader.GetPoolRecoveryOperation(ctx, taskID, runID, operationID)
}

// RecoverPoolRun 在进入宿主协调器前复用原生工作区可见性与动作权限。
func (s *Service) RecoverPoolRun(ctx context.Context, taskID string, command runsmodels.PoolRecoveryCommand) (*runsmodels.RunEvent, error) {
	decision, err := s.poolRecoveryDecision(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if !decision.Has(authz.ScopeTaskWrite) {
		return nil, ErrForbidden
	}
	if command.Action == "stop" && !decision.Has(authz.ScopeSessionControl) {
		return nil, ErrForbidden
	}
	if command.Action == "retry" && !decision.Has(authz.ScopeSessionExec) {
		return nil, ErrForbidden
	}
	coordinator, supported := s.poolRunQueue.(poolRunRecoverer)
	if !supported {
		return nil, runsmodels.ErrPoolAdmissionUnavailable
	}
	return coordinator.RecoverPoolRun(ctx, taskID, command)
}

func (s *Service) poolRecoveryDecision(ctx context.Context, taskID string) (authz.Decision, error) {
	if taskID == "" || len(taskID) > 256 || strings.TrimSpace(taskID) != taskID {
		return authz.Denied(), repoerrors.ErrTaskNotFound
	}
	task, err := s.tasks.GetTask(ctx, taskID)
	if err != nil {
		return authz.Denied(), err
	}
	if task == nil || task.WorkspaceID == "" {
		return authz.Denied(), repoerrors.ErrTaskNotFound
	}
	return s.requireWorkspaceScope(ctx, task.WorkspaceID, authz.ScopeWorkspaceRead, repoerrors.ErrTaskNotFound)
}
