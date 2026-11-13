#  to run: delete .strava.secrets, run again, authorize in the browser, paste the url
#  a full run from the start is ~300 activities at 10 seconds each, so about 50 minutes
import time
from pathlib import Path

from strava_client.client import StravaClient
from strava_client.models.api import StravaActivity
from datetime import datetime, timedelta
import polars

from dotenv import load_dotenv

load_dotenv()
# delete the .strava.secrets file to reset authentication flow because its always expired seemingly
secrets_file = Path(".strava.secrets")
if secrets_file.exists():
    secrets_file.unlink()

TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def activity_times(activity: StravaActivity) -> dict:
    """Wall clock start/end in local time. elapsed_time includes pauses, unlike moving_time."""
    start = activity.start_date_local
    return dict(
        elapsed_s=activity.elapsed_time,
        start_time=start.strftime(TIME_FORMAT),
        end_time=(start + timedelta(seconds=activity.elapsed_time)).strftime(TIME_FORMAT),
    )


def activity_url(activity: StravaActivity) -> str:
    return f"https://www.strava.com/activities/{activity.id}"


client = StravaClient(scopes=["activity:read_all", "profile:read_all", "read_all"])

# I started on May 18th 2025
START_DATE = datetime(2025, 5, 17)
PER_PAGE = 200

activities: list[StravaActivity] = []
page = 1
while True:
    batch = client.get_activities(after=START_DATE, page=page, per_page=PER_PAGE)
    activities.extend(batch)
    if len(batch) < PER_PAGE:
        break
    page += 1

print(f"Found {len(activities)} activities.")


df = polars.DataFrame()
for activity in activities:
    latest_date = activity.start_date_local.strftime("%Y-%m-%d")
    url = activity_url(activity)
    data = dict(
        date=activity.start_date_local.strftime("%Y-%m-%d"),
        name=activity.name, 
        time_s=activity.moving_time,
        **activity_times(activity),
        distance_m=activity.distance,
        url=url,
    )
    #  max 100 rwquests every 15 minutes, so need 9 second interval to not get rate limited when over 100 activities
    while True:
        try:
            activity_detailed = client.get_activity_detailed(activity.id)
            break
        except Exception as e:
            # most likely the rate limit, which resets every 15 minutes
            print(f"Request failed for {activity.name} ({e}), retrying in 15 minutes.")
            time.sleep(15 * 60)
    polyline = activity_detailed.map.polyline
    print(f"Got polyline for {activity.name}: {polyline}")
    data.update({"polyline": polyline})
    print(f"Saving {activity.name}: {url} to csv.")
    time.sleep(10)

    df = df.vstack(polars.DataFrame(data, orient="row"))

df = df.sort("date")

unique_dates = sorted(df["date"].unique().to_list())
date_to_day = {d: i + 1 for i, d in enumerate(unique_dates)}
first_date = datetime.strptime(unique_dates[0], "%Y-%m-%d")
date_to_elapsed = {
    d: (datetime.strptime(d, "%Y-%m-%d") - first_date).days
    for d in unique_dates
}

df = df.with_columns(
    polars.Series("day", [date_to_day[d] for d in df["date"].to_list()]),
    polars.Series("days_elapsed", [date_to_elapsed[d] for d in df["date"].to_list()]),
)

output_folder = Path("strava_data")
output_folder.mkdir(exist_ok=True)
# the csv is gitignored because it has some activities near my house
df.write_csv(str(output_folder / f"activities-{latest_date}.csv"))


