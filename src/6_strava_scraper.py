#  to run: delete .strava.secrets, run again, authorize in the browser, paste the url
import time
from pathlib import Path

from strava_client.client import StravaClient
from strava_client.models.api import StravaActivity
from datetime import datetime
import polars

from dotenv import load_dotenv

load_dotenv()
# delete the .strava.secrets file to reset authentication flow because its always expired seemingly
secrets_file = Path(".strava.secrets")
if secrets_file.exists():
    secrets_file.unlink()

client = StravaClient(scopes=["activity:read_all", "profile:read_all", "read_all"])

activities: list[StravaActivity] = client.get_activities(after=datetime(2026, 5, 1), per_page=200) # I started on May 18th

print(f"Found {len(activities)} activities.")


df = polars.DataFrame()
for activity in activities:
    latest_date = activity.start_date_local.strftime("%Y-%m-%d")
    url = f"https://www.strava.com/activities/{activity.id}"
    data = dict(
        date=activity.start_date_local.strftime("%Y-%m-%d"),
        name=activity.name, 
        time_s=activity.moving_time,
        distance_m=activity.distance,
        url=url,
    )
    #  max 100 rwquests every 15 minutes, so need 9 second interval to not get rate limited when over 100 activities
    activity_detailed = client.get_activity_detailed(activity.id)
    polyline = activity_detailed.map.polyline
    print(f"Got polyline for {activity.name}: {polyline}")
    data.update({"polyline": polyline})
    print(f"Saving {activity.name}: {url} to csv.")
    time.sleep(10)

    df = df.vstack(polars.DataFrame(data, orient="row"))

# include current date in 
output_folder = Path("strava_data")
output_folder.mkdir(exist_ok=True)
df.write_csv(str(output_folder / f"activities-{latest_date}.csv"))


