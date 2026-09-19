"""已知管理端页面路由与审核请求的确定性一致性校验。"""

from types import MappingProxyType
from urllib.parse import unquote, urlsplit

from app.businesses.packs import BUSINESS_PACKS
from app.businesses.registry import BusinessProfileNotFound
from app.models.review import BusinessType, Region, ReviewRequest

# 已声明扩展包的业务，其页面地址来自声明；尚未声明的业务保留显式路由。
ADMIN_REVIEW_ROUTES = MappingProxyType(
    {
        **{
            path: (BusinessType(pack.business_type), declaration.region)
            for pack in BUSINESS_PACKS.values()
            for declaration in pack.regions
            for path in declaration.admin_paths
        },
        "/consistency-qingdao": (BusinessType.CONSISTENCY, Region.QINGDAO),
        "/consistency-changchun": (BusinessType.CONSISTENCY, Region.CHANGCHUN),
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
            if (request.business_type, request.region) != expected:
                raise BusinessContextMismatch(
                    f"页面路由要求 {expected[0].value}/{expected[1].value}，与请求业务或地区不一致"
                )
            return
