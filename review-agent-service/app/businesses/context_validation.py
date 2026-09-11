"""已知管理端页面路由与审核请求的确定性一致性校验。"""

from types import MappingProxyType
from urllib.parse import unquote, urlsplit

from app.businesses.registry import BusinessProfileNotFound
from app.models.review import BusinessType, Region, ReviewRequest

ADMIN_REVIEW_ROUTES = MappingProxyType(
    {
        "/scrap-replace-qingdao": (BusinessType.SCRAP_REPLACEMENT, Region.QINGDAO),
        "/scrap-replace-changchun": (BusinessType.SCRAP_REPLACEMENT, Region.CHANGCHUN),
        "/consistency-qingdao": (BusinessType.CONSISTENCY, Region.QINGDAO),
        "/consistency-changchun": (BusinessType.CONSISTENCY, Region.CHANGCHUN),
    }
)

# 一致性页面容器可由既有过户凭证指纹明确识别为过户子业务。
# 例外同时限定路由、业务、地区和阶段，不能借 transfer 绕过报废地区校验。
ADMIN_ROUTE_COMPATIBLE_CONTEXTS = MappingProxyType(
    {
        "/consistency-qingdao": frozenset(
            {(BusinessType.TRANSFER, Region.DEFAULT, "transfer")}
        ),
        "/consistency-changchun": frozenset(
            {(BusinessType.TRANSFER, Region.DEFAULT, "transfer")}
        ),
    }
)


class BusinessContextMismatch(BusinessProfileNotFound):
    """请求业务/地区与已知页面路由矛盾，禁止执行审核。"""


def validate_request_route(request: ReviewRequest) -> None:
    url = urlsplit(str(request.page_url))
    if url.hostname != "admin.forjtruck.com":
        return
    path = unquote(url.path)
    for route, expected in ADMIN_REVIEW_ROUTES.items():
        if path == route or path.startswith(f"{route}/"):
            if (
                request.business_type,
                request.region,
                request.workflow_stage,
            ) in ADMIN_ROUTE_COMPATIBLE_CONTEXTS.get(route, frozenset()):
                return
            if (request.business_type, request.region) != expected:
                raise BusinessContextMismatch(
                    f"页面路由要求 {expected[0].value}/{expected[1].value}，与请求业务或地区不一致"
                )
            return
