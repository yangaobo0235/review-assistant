"""业务配置解析。

主要职责：安全解析精确配置及允许的默认地区回退。
修改日期：2026-08-26
修改人：wuyi
"""

from app.businesses.profiles import BUSINESS_PROFILES, BusinessProfile
from app.models.review import BusinessType, Region


class BusinessProfileNotFound(LookupError):
    """Raised when the requested business profile cannot be resolved safely."""


class BusinessRegistry:
    def __init__(self, profiles: tuple[BusinessProfile, ...]) -> None:
        self._profiles = {
            (profile.business_type, profile.region, profile.version): profile
            for profile in profiles
        }

    def resolve(
        self,
        business_type: BusinessType,
        region: Region,
        version: str,
    ) -> BusinessProfile:
        """解析请求对应的业务配置，仅执行显式允许的地区回退。"""

        exact = self._profiles.get((business_type, region, version))
        if exact is not None:
            return exact
        default = self._profiles.get((business_type, Region.DEFAULT, version))
        if default is not None:
            return default
        raise BusinessProfileNotFound(
            f"No profile for {business_type.value}/{region.value}/{version}"
        )


def build_business_registry() -> BusinessRegistry:
    return BusinessRegistry(BUSINESS_PROFILES)
