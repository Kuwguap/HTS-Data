# app.py (or whatever you name your Preswald app file)

# 1. Load the dataset
from preswald import connect, get_df

# Initialize connection to preswald.toml data sources
connect()
# Load your dataset from the uploaded file
df = get_df("my_dataset") # 

# 2. Query or manipulate the data
from preswald import query

# SQL query to filter data where 'General Rate of Duty' is not 'Free'
# Note: Column names with spaces require double quotes in SQL.
sql = "SELECT * FROM my_dataset WHERE \"General Rate of Duty\" != 'Free'" # 
filtered_df = query(sql, "my_dataset") # 

# 3. Build an interactive UI
from preswald import table, text

# Display a main title for the app
text("# HTS Data Analysis App")
# Display the filtered data in an interactive table with a title
table(filtered_df, title="HTS Entries with Specific Duties")

# 4. Create a visualization
from preswald import plotly
import plotly.express as px

# Create a scatter plot using the original DataFrame 'df'
# Using 'HTS Number' for x-axis, 'Indent' for y-axis, and 'Description' for color.
# These columns are available in the uploaded CSV.
# Note: 'General Rate of Duty' would require cleaning for a quantitative y-axis.
fig = px.scatter(df, x="HTS Number", y="Indent", color="Description", 
                 title="HTS Number vs. Indent by Description") # 
# Display the Plotly figure in the app
plotly(fig)