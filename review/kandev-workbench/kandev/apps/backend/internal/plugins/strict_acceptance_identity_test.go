package plugins

import (
	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/pkg/pluginsdk"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStrictAcceptanceRequiresRealIdentity(t *testing.T) {
	invoker := &recordingActionInvoker{response: &pluginsdk.PluginActionResponse{Body: []byte(`{"ok":true}`)}}
	router, svc := newActionTestRouter(t, invoker)
	record, err := svc.Install(t.Context(), adminActionPackage(t))
	if err != nil {
		t.Fatal(err)
	}
	svc.SetStrictCompletionVerifierID("plugin:" + record.InstallationID)
	req := httptest.NewRequest(http.MethodPost, "/api/plugins/kandev-plugin-admin-action/actions/connection.set", strings.NewReader(`{"workspaceId":"workspace-1","body":{}}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(authn.WithIdentity(req.Context(), authn.Identity{UserID: "implicit", Role: authn.RoleAdmin, Synthetic: true}))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	if response.Code != http.StatusForbidden || invoker.calls != 0 {
		t.Fatalf("合成管理员能够调用人工验收: %d %d", response.Code, invoker.calls)
	}
	real := doActionRequestAsRole(router, authn.RoleAdmin)
	if real.Code != http.StatusOK || invoker.calls != 1 {
		t.Fatalf("真实管理员被误拦: %d %d", real.Code, invoker.calls)
	}
}
