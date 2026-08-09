package proxy

import (
	"github.com/hayou2002/command-code-proxy/internal/models"
)

// resolveModel maps a client-supplied model name to a full upstream id.
// The provider API requires full ids (vendor/model), so short names must
// be expanded via the registry. Unknown names pass through unchanged.
func resolveModel(store *models.ModelStore, name string) string {
	if store == nil {
		return name
	}
	return store.Resolve(name)
}
