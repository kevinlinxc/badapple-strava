#  to run: delete .strava.secrets, run again, authorize in the browser, paste the url
from strava_client.client import StravaClient
from strava_client.models.api import StravaActivity
from datetime import datetime
import polars

from dotenv import load_dotenv

load_dotenv()

client = StravaClient(scopes=["activity:read_all", "profile:read_all", "read_all"])

activities: list[StravaActivity] = client.get_activities(after=datetime(2025, 5, 18), per_page=100) # I started on May 18th

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
    print(f"Saving {activity.name}: {url} to csv.")
    df = df.vstack(polars.DataFrame(data, orient="row"))

# include current date in 
df.write_csv(f"activities-{latest_date}.csv")


