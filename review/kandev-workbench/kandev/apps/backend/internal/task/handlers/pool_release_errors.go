package handlers

import (
	"errors"
	"net/http"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	ws "github.com/kandev/kandev/pkg/websocket"
)

// poolReleaseError 只向两种传输暴露固定领域代码，不回传内部错误或请求中的身份字段。
func poolReleaseError(err error) (int, string, string, bool) {
	switch {
	case errors.Is(err, repoerrors.ErrPoolReleaseConfirmationRequired):
		return http.StatusConflict, ws.ErrorCodeConflict, repoerrors.ErrPoolReleaseConfirmationRequired.Error(), true
	case errors.Is(err, repoerrors.ErrTaskVersionConflict):
		return http.StatusConflict, ws.ErrorCodeConflict, "task_version_conflict", true
	case errors.Is(err, repoerrors.ErrPoolStepChanged):
		return http.StatusConflict, ws.ErrorCodeConflict, repoerrors.ErrPoolStepChanged.Error(), true
	case errors.Is(err, models.ErrPoolExecutionUnavailable):
		return http.StatusServiceUnavailable, ws.ErrorCodeUnavailable, models.ErrPoolExecutionUnavailable.Error(), true
	case errors.Is(err, runsmodels.ErrPoolAdmissionUnavailable):
		return http.StatusServiceUnavailable, ws.ErrorCodeUnavailable, runsmodels.ErrPoolAdmissionUnavailable.Error(), true
	default:
		return 0, "", "", false
	}
}
