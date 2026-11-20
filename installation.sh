brew install kind kubectl helm docker

# flexprice

helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add temporalio https://go.temporal.io/helm-charts
helm repo update

gh repo clone flexprice/flexprice
cd internal/ee/infrastructure/helm/
./provision.sh 


# flexprice-local

gh repo clone niravshah2705/symphony
cd symphony/dev

# llmgateway
helm upgrade --install litellm oci://ghcr.io/berriai/litellm-helm \
                                                          --version 1.109.1 \
                                                          --namespace litellm --values litellm.yaml \
                                                          --wait --create-namespace


helm upgrade --install substrate-crds \
  oci://ghcr.io/kagent-dev/substrate/helm/substrate-crds \
  --namespace ate-system --create-namespace --wait

helm upgrade --install substrate \
  oci://ghcr.io/kagent-dev/substrate/helm/substrate \
  --namespace ate-system --wait --timeout 10m

#kagent
helm install kagent-crds oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds \
                                                            --namespace kagent \
                                                            --create-namespace


# cli 
curl https://raw.githubusercontent.com/kagent-dev/kagent/refs/heads/main/scripts/get-kagent | bash -s -- --version v1.0.0
                                                    kagent version

