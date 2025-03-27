import utm
import math
import datetime
import os

example_park_a_tr = 37.373400, -122.079526
example_park_a_bl = 37.372149, -122.08197

example_park_b_bl = 37.372149, -122.08197
example_park_b_tr = 37.373400, -122.079526

toronto_bl = 43.644057, -79.418834
toronto_tr = 43.670315, -79.386814


def x_y_to_gps(x, y, width, height, bottom_left_lat_long=toronto_bl, top_right_lat_long=toronto_tr, 
               angle_degrees=0, skew_x_degrees=0, skew_y_degrees=0, x_scale=1.0, y_scale=1.0):
    """
    Convert x,y coordinates to GPS coordinates with support for transformation.
    
    Args:
        x, y: Coordinates in the original space
        width, height: Dimensions of the original space
        bottom_left_lat_long: GPS coordinates of bottom left corner
        top_right_lat_long: GPS coordinates of top right corner
        angle_degrees: Rotation angle in degrees (clockwise from normal orientation)
        skew_x_degrees: Horizontal skew angle in degrees
        skew_y_degrees: Vertical skew angle in degrees
        x_scale: Scaling factor for x-coordinates (>1 expands, <1 compresses)
        y_scale: Scaling factor for y-coordinates (>1 expands, <1 compresses)
    
    Returns:
        (latitude, longitude) tuple
    """
    # Convert bottom-left and top-right lat/lon to UTM
    bl_lat, bl_lon = bottom_left_lat_long
    tr_lat, tr_lon = top_right_lat_long
    
    bl_easting, bl_northing, bl_zone_number, bl_zone_letter = utm.from_latlon(bl_lat, bl_lon)
    tr_easting, tr_northing, tr_zone_number, tr_zone_letter = utm.from_latlon(tr_lat, tr_lon)
    
    # Ensure both points are in the same UTM zone
    if bl_zone_number != tr_zone_number or bl_zone_letter != tr_zone_letter:
        raise ValueError("The two points are not in the same UTM zone")
    
    # Calculate the UTM coordinates of the point based on x, y, width, and height
    x_ratio = x / width
    y_ratio = y / height
    
    # Center the coordinate system (move to origin)
    x_centered = x_ratio - 0.5
    y_centered = y_ratio - 0.5
    
    # Apply scaling
    x_transformed = x_centered * x_scale
    y_transformed = y_centered * y_scale
    
    # Apply skew transformations
    if skew_x_degrees != 0:
        # Horizontal skew (shifts x based on y position)
        skew_x_rad = math.radians(skew_x_degrees)
        x_transformed += y_transformed * math.tan(skew_x_rad)
    
    if skew_y_degrees != 0:
        # Vertical skew (shifts y based on x position)
        skew_y_rad = math.radians(skew_y_degrees)
        y_transformed += x_transformed * math.tan(skew_y_rad)
    
    # Apply rotation if needed
    if angle_degrees != 0:
        angle_radians = math.radians(angle_degrees)
        x_rot = x_transformed * math.cos(angle_radians) - y_transformed * math.sin(angle_radians)
        y_rot = x_transformed * math.sin(angle_radians) + y_transformed * math.cos(angle_radians)
        x_transformed = x_rot
        y_transformed = y_rot
    
    # Move back from origin
    x_ratio = x_transformed + 0.5
    y_ratio = y_transformed + 0.5
    
    # Calculate the interpolated UTM coordinates
    point_easting = bl_easting + (tr_easting - bl_easting) * x_ratio
    point_northing = bl_northing + (tr_northing - bl_northing) * y_ratio
    
    # Convert the UTM coordinates back to lat/lon
    point_lat, point_lon = utm.to_latlon(point_easting, point_northing, bl_zone_number, bl_zone_letter)
    
    return point_lat, point_lon

def rect_to_parallelogram(x, y, width, height, top_skew=0, bottom_skew=0, left_skew=0, right_skew=0, **kwargs):
    """
    Transform coordinates from a rectangle to a parallelogram.
    
    Args:
        x, y: Original coordinates
        width, height: Original dimensions
        top_skew: How much the top edge is shifted horizontally (positive = right)
        bottom_skew: How much the bottom edge is shifted horizontally
        left_skew: How much the left edge is shifted vertically (positive = up)
        right_skew: How much the right edge is shifted vertically
        **kwargs: Additional arguments to pass to x_y_to_gps
        
    Returns:
        (latitude, longitude) tuple
    """
    # Normalized coordinates (0-1)
    nx = x / width
    ny = y / height
    
    # Calculate x shift based on y position (interpolating between bottom and top skew)
    x_shift = bottom_skew * (1 - ny) + top_skew * ny
    
    # Calculate y shift based on x position (interpolating between left and right skew)
    y_shift = left_skew * (1 - nx) + right_skew * nx
    
    # Apply the shifts to the coordinates
    new_x = x + x_shift * width
    new_y = y + y_shift * height
    
    # Now convert to GPS using the standard function
    return x_y_to_gps(new_x, new_y, width, height, **kwargs)

def export_to_gpx(gps_points, output_file="track.gpx", name="Generated Track", description="Track generated from coordinates"):
    """
    Export a list of GPS coordinates to a GPX file.
    
    Args:
        gps_points: List of (latitude, longitude) tuples
        output_file: Path to save the output GPX file
        name: Name of the track
        description: Description of the track
    
    Returns:
        Path to the saved GPX file
    """
    # Create GPX header
    gpx_content = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="GPS.py"',
        '     xmlns="http://www.topografix.com/GPX/1/1"',
        '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
        f'  <metadata>',
        f'    <name>{name}</name>',
        f'    <desc>{description}</desc>',
        f'    <time>{datetime.datetime.now().isoformat()}Z</time>',
        f'  </metadata>',
        '  <trk>',
        f'    <name>{name}</name>',
        '    <trkseg>'
    ]
    
    # Add track points
    for lat, lon in gps_points:
        gpx_content.append(f'      <trkpt lat="{lat}" lon="{lon}"></trkpt>')
    
    # Close the GPX structure
    gpx_content.extend([
        '    </trkseg>',
        '  </trk>',
        '</gpx>'
    ])
    
    # Write to file
    with open(output_file, 'w') as f:
        f.write('\n'.join(gpx_content))
    
    print(f"GPX file saved to: {os.path.abspath(output_file)}")
    return output_file

def create_track_from_points(points, width, height, **kwargs):
    """
    Create a GPS track from a list of (x,y) points.
    
    Args:
        points: List of (x, y) tuples in pixel coordinates
        width, height: Dimensions of the coordinate space
        **kwargs: Additional parameters to pass to x_y_to_gps
        
    Returns:
        List of (latitude, longitude) tuples
    """
    gps_points = []
    for x, y in points:
        lat, lon = x_y_to_gps(x, y, width, height, **kwargs)
        gps_points.append((lat, lon))
    return gps_points

# Example usage:
if __name__ == "__main__":
    x, y = 100, 200  # Example point in the video
    width, height = 1920, 1080  # Example video dimensions
    
    # Standard mapping
    lat, lon = x_y_to_gps(x, y, width, height)
    print(f"Standard - Latitude: {lat}, Longitude: {lon}")
    
    # With scaling to fix compressed horizontally/stretched vertically
    lat_scaled, lon_scaled = x_y_to_gps(x, y, width, height, x_scale=1.5, y_scale=0.8)
    print(f"Scaled - Latitude: {lat_scaled}, Longitude: {lon_scaled}")
    
    # Complete example with scaling, skew, and rotation
    lat_complete, lon_complete = x_y_to_gps(
        x, y, width, height,
        x_scale=1.5,  # Expand horizontally by 50%
        y_scale=0.8,  # Compress vertically by 20%
        skew_x_degrees=15,
        angle_degrees=5
    )
    print(f"Complete transform - Latitude: {lat_complete}, Longitude: {lon_complete}")
    
    # Using the parallelogram transformation with scaling
    lat_para, lon_para = rect_to_parallelogram(
        x, y, width, height,
        top_skew=0.15,
        x_scale=1.5,
        y_scale=0.8,
        bottom_left_lat_long=toronto_bl,
        top_right_lat_long=toronto_tr
    )
    print(f"Parallelogram with scaling - Latitude: {lat_para}, Longitude: {lon_para}")
    
    # Create a sample track
    width, height = 1920, 1080
    points = [(100, 200), (300, 400), (500, 600), (700, 800), (900, 900)]
    
    # Convert points to GPS coordinates with transformations
    gps_track = create_track_from_points(
        points, width, height,
        x_scale=1.2, 
        y_scale=0.9,
        skew_x_degrees=10,
        bottom_left_lat_long=example_park_b_bl,
        top_right_lat_long=example_park_b_tr
    )
    
    # Export to GPX file
    gpx_file = export_to_gpx(
        gps_track, 
        output_file="sample_track.gpx", 
        name="Sample Generated Track", 
        description="Track generated from sample points"
    )
    print(f"Track exported to {gpx_file}")

